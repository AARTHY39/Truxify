# Split-conformal ETA interval contract

The absolute-residual threshold is order statistic `ceil((n+1)*(1-alpha))`.
Rank n+1 requires infinity, not the largest observed score. See Section1.1 and
AppendixD of [Angelopoulos and Bates](https://arxiv.org/pdf/2107.07511).
The marginal target requires exchangeable held-out calibration/test scores for a
fixed predictor. It does not establish coverage under arbitrary weather/temporal
shift or certify the demonstration dataset as production calibration.

## Migration

- Default six demonstration scores at alpha0.05 now give internal q_hat infinity.
  JSON returns `conformal_q_hat_margin: null`, lower0, uppernull,
  `interval_unbounded: true`, `calibration_rank_unbounded: true`, size6/rank7.
  Interpret a null upper endpoint as no finite upper limit, not missing data or0.
- Provide independent calibration residuals with the optional `calibration_scores`
  argument. Nineteen scores at alpha0.05 allow a finite maximum threshold.
  Caller-provided data are marked `provided`; this does not verify their provenance
  or statistical assumptions. Legacy attribute replacement is revalidated per call.
- Alpha uses its shortest decimal representation, so0.05 is exactly1/20 for rank
  selection. Adjacent representable alpha values remain distinguishable.
- Finite endpoints are widened outward by one floating-point step and are not
  rounded for display. Preserve the numeric endpoints for membership checks.
  Upper arithmetic overflow is also represented by uppernull/unboundedtrue,
  while the finite margin and `calibration_rank_unbounded: false` remain available.
- `coverage_guarantee_pct` is retained as a conditional marginal target for
  compatibility; read `coverage_assumptions` with it. It is not measured coverage,
  per-trip probability, or a production certificate. Nonnegative ETA targets are
  required for the lower0 truncation.
- Input scores must be a nonempty, finite, real, nonnegative vector. Alpha must be
  finite in(0,1); baseline must be finite, nonnegative and float-representable.

## Native verification

```
python -m pip install numpy==1.26.4 pytest==9.0.3 ruff==0.16.9
PYTHONPATH=backend/ml/uncertainty python -m pytest -q backend/ml/uncertainty/test_conformal.py backend/ml/uncertainty/test_conformal_coverage.py
python -m ruff check backend/ml/uncertainty/conformal_eta.py backend/ml/uncertainty/test_conformal.py backend/ml/uncertainty/test_conformal_coverage.py
```

Independent Decimal rank selection, exhaustive held-out ranks and calibration
permutations, ties, sub-cent endpoint membership, owned inputs, invalid admission,
strict JSON and adjacent-alpha boundary controls exercise the actual NumPy code.
The original tests now check the corrected default contract. No production route,
provider, coverage monitoring or predictor training is added.
