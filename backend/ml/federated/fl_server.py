import numpy as np

class FederatedAveragingServer:
    """
    FedAvg Aggregator Server. Aggregates encrypted/compressed local model weight updates from Driver Apps.
    """
    def __init__(self, num_weights: int = 10):
        self.num_weights = num_weights
        self.global_weights = np.zeros(num_weights)

    def aggregate_updates(self, client_updates: list) -> np.ndarray:
        """
        client_updates: List of dicts containing {"weights": np.ndarray, "num_samples": int}
        """
        if not client_updates:
            return self.global_weights

        total_samples = sum(c["num_samples"] for c in client_updates)
        weighted_sum = np.zeros(self.num_weights)

        for client in client_updates:
            weight = client["num_samples"] / total_samples
            weighted_sum += client["weights"] * weight

        self.global_weights = weighted_sum
        return self.global_weights

fl_server = FederatedAveragingServer()


def robust_aggregate(layer_weights, global_weights=None, clip_norm=1.0):
    """Coordinate-wise median aggregator (byzantine-robust).

    Unlike a naive ``np.mean``, the median is resistant to a single malicious
    or compromised client submitting extreme weights: one outlier cannot move
    the median materially. When ``global_weights`` is provided, the per-layer
    delta from the previous global weights is clipped to ``clip_norm`` so even
    several colluding clients cannot shift the global model arbitrarily.

    Parameters
    ----------
    layer_weights : iterable of array-like
        Per-client weight arrays for a single layer (same shape each).
    global_weights : array-like, optional
        Previous global weights for this layer, used to clip the update delta.
    clip_norm : float
        Maximum L2 norm of the aggregated delta.
    """
    if (isinstance(clip_norm, (bool, np.bool_)) or not np.isscalar(clip_norm)
            or np.asarray(clip_norm).dtype.kind not in 'fiu'):
        raise ValueError("clip_norm must be a finite nonnegative numeric scalar")
    try:
        radius = float(clip_norm)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError("clip_norm must be a finite nonnegative numeric scalar") from exc
    if not np.isfinite(radius) or radius < 0:
        raise ValueError("clip_norm must be finite and nonnegative")

    def numeric_layer(value):
        array = np.asarray(value)
        if array.dtype.kind not in 'fiu' or not array.size:
            raise ValueError("layers must be nonempty real numeric arrays")
        with np.errstate(over='ignore', invalid='ignore'):
            array = array.astype(np.float64)
        if not np.isfinite(array).all():
            raise ValueError("layers must contain finite representable values")
        return array

    layers = [numeric_layer(w) for w in layer_weights]
    if not layers or any(w.shape != layers[0].shape for w in layers):
        raise ValueError("client layers must have identical nonempty shapes")
    baseline = None if global_weights is None else numeric_layer(global_weights)
    if baseline is not None and baseline.shape != layers[0].shape:
        raise ValueError("global layer must exactly match client layer shape")

    ordered = np.sort(np.stack(layers, axis=0), axis=0)
    middle = len(layers) // 2
    if len(layers) % 2:
        median = ordered[middle].copy()
    else:
        lower, upper = ordered[middle - 1], ordered[middle]
        same_sign = np.signbit(lower) == np.signbit(upper)
        large = same_sign & ((np.abs(lower) > np.finfo(float).max / 2)
                             | (np.abs(upper) > np.finfo(float).max / 2))
        median = np.empty_like(lower)
        # Safe sums retain subnormal rounding; bounded same-sign differences
        # avoid overflow only where the ordinary midpoint sum is unsafe.
        median[~large] = (lower[~large] + upper[~large]) / 2
        median[large] = lower[large] + (upper[large] - lower[large]) / 2

    if baseline is not None and radius > 0:
        with np.errstate(over='ignore', invalid='ignore'):
            delta = median - baseline
        if np.isfinite(delta).all():
            # Scale the difference itself: a large unchanged coordinate must
            # not erase a much smaller update in a different coordinate.
            scale = float(np.max(np.abs(delta)))
            direction = delta / scale if scale > 0 else delta
        else:
            scale = max(float(np.max(np.abs(median))), float(np.max(np.abs(baseline))))
            # Only overflowing subtraction needs endpoint scaling; some
            # direction coordinate is then larger than1, so the norm is safe.
            direction = median / scale - baseline / scale
        if scale > 0:
            length = float(np.linalg.norm(direction))
            if length > 0 and scale > radius / length:
                median = baseline + direction * (radius / length)
    if not np.isfinite(median).all():
        raise ValueError("aggregate must be representable finitely")
    return median
