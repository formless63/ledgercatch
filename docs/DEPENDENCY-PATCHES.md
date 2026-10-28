# Reviewed dependency patches

`deepmerge` 4.3.1 is used by build tooling. Its published release has no upstream fix for [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). Bun applies the committed patch to the source and both distributed entrypoints, rejecting `__proto__` keys in both the target-copy and source-copy loops. This covers null-prototype targets, owned dangerous keys and nested placeholder values while retaining normal merge and array behavior. See the [upstream report](https://github.com/TehShrike/deepmerge/issues/273).

Run `bun run security:audit`. Before accepting the single registry-version exception, it verifies SHA-256 for every patched file and exercises the reported attack shapes against the installed package. Missing, changed or unapplied patches fail the gate. Every other advisory still fails. The extension receives a normal unfiltered audit. Plain `bun audit` continues to report the original registry-version advisory because it cannot inspect patched bytes.

Remove the local patch, byte checks and exception together when a reviewed upstream fix is released. `qs` is pinned to the compatible 6.16.1 security patch; no runtime API or dependency major version changes are involved.
