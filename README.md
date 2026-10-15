# PeerMeet deploy

Deploy tooling for [bertha-hallo/PeerMeet](https://github.com/bertha-hallo/PeerMeet). The application code lives there; this repo holds only the Dockerfile, smoke test and CI/CD workflows.

- `poll-upstream` checks the upstream `main` every 10 minutes and starts `ci-deploy` when it has a commit that was not attempted yet (recorded as a `seen-<app sha>-<tooling sha>` tag in this repo).
- `ci-deploy` builds that commit with this repo's Dockerfile and smoke-tests it. On `main` it then connects to the server over a restricted SSH key and passes the two commit SHAs; the server fetches both repos, builds the image itself, starts it, and rolls back to the previous image if it does not become healthy.
- Nothing is published to a registry. The run summary lists the upstream commits being shipped.
- Pull requests here build and smoke-test the current upstream `main` with the proposed tooling.
- A commit that failed is not retried automatically. Retry with *Actions → ci-deploy → Run workflow* and tick *force*.
- The deploy job only runs while the repository variable `PEERMEET_ENABLED` is `true`.
