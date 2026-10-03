# Routine Jev delegation

Use fusion_assist first for supported repository tasks, including known small reads, lists, searches and Git checks. Give it a short task, the active project's absolute root, and a narrow scope. With a configured Jev key, Fusion asks Jev to select the validated action before collecting local evidence. Inspection is an explicit recovery or escalation fallback.

For an exact command, supply command: {program, argv} to fusion_assist. Jev selects the original command plan or escalates; it cannot invent arguments. Execute the returned execution program and argv through Fusion using existing user authorization and host policy. The assistance server itself does not execute arbitrary commands. Requested test/build/lint recipes are grounded in project manifests and selected by Jev.

Check telemetry.jevCalls and providerTokens. A successful live delegated operation reports a Jev call and returned provider usage; a deterministic inspection reports no model call. Continuation pages reuse the already-selected action. Missing keys leave deterministic local tools available; provider failures and declined selections return control to the host without silently executing the rejected action.

Public Fusion uses official TypeSafe Jev. Configure an official key for live delegation. Restart the host session after updating adapters so it loads the new tool schema and guidance.
