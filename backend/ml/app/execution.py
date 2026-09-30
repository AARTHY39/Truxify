"""Bounded execution helpers for CPU-bound / blocking ML work.

FastAPI async endpoints must never run CPU-bound inference or blocking I/O
directly on the event loop: a single expensive request would stall every
other request, including ``/health``.  This module provides a shared, bounded
``ThreadPoolExecutor`` plus an ``asyncio.Semaphore`` so expensive inference is
executed off the event loop with a configurable concurrency cap and
deterministic backpressure (HTTP 503 when saturated).

Configuration (environment variables):

- ``ML_MAX_CONCURRENT_INFERENCE``         max in-flight inferences (default 4).
- ``ML_INFERENCE_MAX_WORKERS``            executor threads (default 4).
- ``ML_INFERENCE_QUEUE_TIMEOUT_SECONDS``  how long a request waits for an
  inference slot before the service sheds load with 503 (default 5.0).

The executor has application/process lifetime: it is created once at import
time and reused for every request.  ``close_inference_executor`` is wired into
the FastAPI shutdown hook so no worker threads leak.

The semaphore is per event loop (weakly referenced from the running loop).
``asyncio`` primitives bind to the loop that first awaits them, and the ML
service's unit tests exercise the app across many short-lived event loops
(one per ``TestClient`` / ``asyncio.run``); a single module-level semaphore
would raise ``RuntimeError: bound to a different event loop``.  In production
uvicorn runs exactly one loop, so capacity is still shared globally.
"""

import asyncio
import logging
import os
import threading
import weakref
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict

from fastapi import HTTPException

logger = logging.getLogger(__name__)

ML_MAX_CONCURRENT_INFERENCE = int(
    os.environ.get("ML_MAX_CONCURRENT_INFERENCE", "4")
)
ML_INFERENCE_MAX_WORKERS = int(os.environ.get("ML_INFERENCE_MAX_WORKERS", "4"))
ML_INFERENCE_QUEUE_TIMEOUT_SECONDS = float(
    os.environ.get("ML_INFERENCE_QUEUE_TIMEOUT_SECONDS", "5.0")
)
ML_TRAINING_MAX_WORKERS = int(os.environ.get("ML_TRAINING_MAX_WORKERS", "2"))
ML_TRAINING_TIMEOUT_SECONDS = float(
    os.environ.get("ML_TRAINING_TIMEOUT_SECONDS", "300")
)

# The executor worker count must never be smaller than the semaphore limit:
# every task that acquires a slot must be able to run promptly instead of
# piling up behind the executor's internal queue.
if ML_INFERENCE_MAX_WORKERS < ML_MAX_CONCURRENT_INFERENCE:
    logger.warning(
        "ML_INFERENCE_MAX_WORKERS (%d) < ML_MAX_CONCURRENT_INFERENCE (%d); "
        "raising workers to match the concurrency limit",
        ML_INFERENCE_MAX_WORKERS,
        ML_MAX_CONCURRENT_INFERENCE,
    )
    ML_INFERENCE_MAX_WORKERS = ML_MAX_CONCURRENT_INFERENCE

_inference_executor: ThreadPoolExecutor = ThreadPoolExecutor(
    max_workers=ML_INFERENCE_MAX_WORKERS,
    thread_name_prefix="ml-inference",
)
# One semaphore per live event loop (weak refs so closed loops are reclaimed).
_inference_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)

# Dedicated bounded executor for training jobs so a long-running training can
# never starve the (smaller, latency-sensitive) inference pool.
_training_executor: ThreadPoolExecutor = ThreadPoolExecutor(
    max_workers=ML_TRAINING_MAX_WORKERS,
    thread_name_prefix="ml-training",
)
_training_admission_lock = threading.Lock()
_active_training_models: set[str] = set()

# Cancellation token for the training job currently running on this worker
# thread. It is thread-local because many worker threads may be training
# different models at the same time, and one job's timeout must not cancel
# another job's training.
_training_cancel = threading.local()


class TrainingCancelled(Exception):
    """Raised inside a training worker whose HTTP request timed out.

    The worker thread cannot be killed, but once cancelled it must abort
    before publishing anything so a timed-out request never deploys a model.
    """


def is_training_cancelled() -> bool:
    """Return True when the calling training worker was cancelled (timeout)."""
    event = getattr(_training_cancel, "event", None)
    return event is not None and event.is_set()


def _run_train_with_cancel(
    model_name: str,
    train_fn: Callable[..., Any],
    cancel_event: threading.Event,
    args,
    kwargs,
) -> Any:
    prev = getattr(_training_cancel, "event", None)
    _training_cancel.event = cancel_event
    try:
        return train_fn(*args, **kwargs)
    except TrainingCancelled:
        # The request already timed out and nobody will read this worker's
        # result; swallow the cancellation so the executor has no unobserved
        # exception to report.
        logger.warning("Training worker cancelled; aborting before publication")
        return None
    finally:
        _training_cancel.event = prev
        # A timed-out request does not stop its thread. Keep admission occupied
        # until the worker really exits, including across event loops.
        with _training_admission_lock:
            _active_training_models.discard(model_name)


def _consume_training_result(fut: "asyncio.Future") -> None:
    """Retrieve (and thereby suppress) a timed-out worker's eventual result or
    exception so the executor never logs 'exception was never retrieved'."""
    if fut.cancelled():
        return
    try:
        fut.exception()
    except Exception:
        pass


async def run_training_job(
    model_name: str,
    train_fn: Callable[..., Any],
    *args: Any,
    timeout: float = ML_TRAINING_TIMEOUT_SECONDS,
    **kwargs: Any,
) -> Any:
    """Run a CPU-bound training job off the event loop with a wall-clock timeout.

    Critical semantics: an ``asyncio`` timeout does NOT terminate a Python
    worker thread. When *timeout* elapses this helper returns/raises
    ``asyncio.TimeoutError`` immediately AND signals the worker thread through
    a cancellation token. The worker keeps running in the background but its
    publish step checks ``is_training_cancelled()`` and aborts, so a
    timed-out request can never deploy an untracked/invalid model.

    Admission is bounded by the worker count; overload is rejected with 503
    instead of entering the executor's unbounded queue. A second job for the
    same model receives 409, even while a timed-out worker is winding down.
    """
    loop = asyncio.get_running_loop()
    cancel_event = threading.Event()
    with _training_admission_lock:
        if model_name in _active_training_models:
            raise HTTPException(
                status_code=409, detail="Model training already in progress"
            )
        if len(_active_training_models) >= ML_TRAINING_MAX_WORKERS:
            raise HTTPException(
                status_code=503, detail="ML training capacity exhausted; retry later"
            )
        _active_training_models.add(model_name)
    try:
        future = loop.run_in_executor(
            _training_executor,
            _run_train_with_cancel,
            model_name,
            train_fn,
            cancel_event,
            args,
            kwargs,
        )
    except BaseException:
        with _training_admission_lock:
            _active_training_models.discard(model_name)
        raise
    future.add_done_callback(_consume_training_result)
    try:
        return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        logger.warning(
            "Training job '%s' cancelled or exceeded %.1fs; signalling cancellation",
            model_name,
            timeout,
        )
        cancel_event.set()
        raise


def close_training_executor() -> None:
    """Gracefully stop the shared training executor (app shutdown)."""
    _training_executor.shutdown(wait=False, cancel_futures=False)
    logger.info("ML training executor shut down")


def _get_semaphore() -> asyncio.Semaphore:
    """Return the semaphore bound to the currently running event loop."""
    loop = asyncio.get_running_loop()
    semaphore = _inference_semaphores.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(ML_MAX_CONCURRENT_INFERENCE)
        _inference_semaphores[loop] = semaphore
    return semaphore


def configure(
    *,
    max_concurrent: int = ML_MAX_CONCURRENT_INFERENCE,
    max_workers: int = ML_INFERENCE_MAX_WORKERS,
    queue_timeout: float = ML_INFERENCE_QUEUE_TIMEOUT_SECONDS,
) -> None:
    """Rebuild the executor and semaphore with the given limits.

    Used by tests to exercise backpressure deterministically.  In-flight work
    still holds a reference to the previous executor / semaphore and releases
    safely, so replacing them never leaks capacity.
    """
    global ML_MAX_CONCURRENT_INFERENCE, ML_INFERENCE_MAX_WORKERS
    global ML_INFERENCE_QUEUE_TIMEOUT_SECONDS, _inference_executor

    if max_workers < max_concurrent:
        logger.warning("max_workers raised to %d to match max_concurrent", max_concurrent)
        max_workers = max_concurrent

    ML_MAX_CONCURRENT_INFERENCE = max_concurrent
    ML_INFERENCE_MAX_WORKERS = max_workers
    ML_INFERENCE_QUEUE_TIMEOUT_SECONDS = queue_timeout

    _inference_executor.shutdown(wait=False, cancel_futures=False)
    _inference_executor = ThreadPoolExecutor(
        max_workers=max_workers,
        thread_name_prefix="ml-inference",
    )
    _inference_semaphores.clear()


async def run_inference(func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run ``func(*args, **kwargs)`` off the event loop under the concurrency cap.

    The callable is executed on a worker thread so neither CPU-bound inference
    nor blocking I/O (e.g. weather HTTP) can stall the event loop.

    When no inference slot is free within ``ML_INFERENCE_QUEUE_TIMEOUT_SECONDS``
    an ``HTTPException`` with status 503 is raised so the client can retry
    instead of queueing requests indefinitely.  Capacity is always released
    (also when the callable raises) and never leaked.
    """
    semaphore = _get_semaphore()
    try:
        await asyncio.wait_for(
            semaphore.acquire(),
            timeout=ML_INFERENCE_QUEUE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "Inference capacity exhausted (limit=%d); returning 503",
            ML_MAX_CONCURRENT_INFERENCE,
        )
        raise HTTPException(
            status_code=503,
            detail="ML inference capacity exhausted; retry later",
        )

    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            _inference_executor,
            lambda: func(*args, **kwargs),
        )
    finally:
        semaphore.release()


def inference_capacity() -> int:
    """Return the configured maximum number of concurrent inferences."""
    return ML_MAX_CONCURRENT_INFERENCE


def close_inference_executor() -> None:
    """Gracefully stop the shared inference executor (app shutdown)."""
    _inference_executor.shutdown(wait=False, cancel_futures=False)
    logger.info("ML inference executor shut down")
