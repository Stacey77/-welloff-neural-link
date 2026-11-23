---
name: engineering-verification
description: How to read AXIOM verification results (safety factor, FEA stress, thermal margin, telemetry alerts) and when a design is safe to release.
---
# Reading engineering verification

- **Safety factor (SF)** = yield strength ÷ peak stress. The design target is set per project (default 2.0). SF < 1 means the part yields: fail. SF below target: warn.
- **Peak stress** comes from a 1D Euler–Bernoulli beam FEA (bending) plus closed-form checks for torsion, pressure and thermal stress. It does not model stress concentrations at holes, welds or fillets; apply a concentration factor or run full 3D FEA before release.
- **Thermal margin** = material max service temperature − operating temperature. Under 15 °C: warn. Negative: fail.
- **Telemetry alerts** re-run verification on live load and temperature readings. Samples marked `simulated` come from the built-in simulator, not real sensors.
- Release only when every component is `ok`, SENTINEL reports no open findings, and the assumptions in the report have been reviewed by a qualified engineer.
