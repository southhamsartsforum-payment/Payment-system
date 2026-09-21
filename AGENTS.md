# AGENTS.md

## Project overview
This repository contains a Firebase-backed, mostly static web application for SHAF payments, catalog management, and visitor counting. The project is organized as separate app folders rather than a single application.

## Key folders
- [Readme](Readme) — project-level notes; keep this in sync with major changes.
- [frontend](frontend) — main frontend content and Firebase hosting config.
- [SHAF/Payment_System](SHAF/Payment_System) — payment system app and sales logic.
- [SHAF/Catalog](SHAF/Catalog) — catalog and artwork management app.
- [SHAF/Visitor_Counter](SHAF/Visitor_Counter) — Firebase-hosted visitor counter.
- [Test Environment](Test Environment) — sandbox/test copies of the app folders; use with caution.
- [apps-script](apps-script), [backend](backend), [config](config) — supporting project areas.

## Firebase and deployment conventions
- Firebase project ID is `shaf-payment-system`.
- Deployment workflow is defined in [.github/workflows/firebase-hosting-merge.yml](.github/workflows/firebase-hosting-merge.yml).
- The release workflow deploys the visitor counter target named `shafcounter` to Firebase Hosting when pushing to the `Visitors` branch.
- App scripts commonly initialize Firestore with the same project ID and `authDomain: shaf-payment-system.firebaseapp.com`.
- Do not change Firebase project IDs, hosting targets, or deployment paths unless the deployment setup is intentionally being updated.

## Working rules for agents
- Treat each app folder as a separate app surface: payment, catalog, and visitor counter are not interchangeable.
- Prefer small, localized edits inside the relevant app folder instead of broad repo-wide changes.
- If a task affects a hosted app, check the corresponding Firebase config and deployment target before editing.
- Because this is a static HTML/JS project, there is usually no build system to run; verify the change by inspecting the relevant app file and deployment config.
- Keep duplicates under [Test Environment](Test Environment) aligned only when intentionally testing changes; avoid editing them unless the task specifically targets the sandbox copy.

## Useful references
- [frontend/firebase.json](frontend/firebase.json)
- [SHAF/Visitor_Counter/firebase.json](SHAF/Visitor_Counter/firebase.json)
- [SHAF/Payment_System/Payment_System.html](SHAF/Payment_System/Payment_System.html)
- [SHAF/Catalog/Catalog.html](SHAF/Catalog/Catalog.html)
- [SHAF/Visitor_Counter/firebase-public/Visitor_counter.html](SHAF/Visitor_Counter/firebase-public/Visitor_counter.html)
