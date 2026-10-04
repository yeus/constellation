# @taskyon/diagnostics

Runtime-neutral test catalog and runner extracted from Taskyon common. Tests receive an abort signal; they must cooperate with cancellation and release resources in finally blocks. Parent cancellation interrupts active tests and prevents later tests. Skips are represented by details.skipped and must be counted separately from passes.

Run `yarn workspace @taskyon/diagnostics test` and `yarn workspace @taskyon/diagnostics build`.
