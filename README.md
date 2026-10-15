# PeerMeet deploy

Deploy tooling for [bertha-hallo/PeerMeet](https://github.com/bertha-hallo/PeerMeet). The application code lives there; this repo holds only the Dockerfile, smoke test and CI/CD workflow.

- The workflow polls the upstream `main` every 10 minutes (and on manual dispatch). A new commit is built with this repo's Dockerfile, smoke-tested and pushed to GHCR.
- The deploy job then waits for approval on the `production` environment. The run summary lists the upstream commits being shipped.
- Pull requests here build and smoke-test the current upstream `main` with the proposed tooling.
- Run a manual build with *Actions → ci-deploy → Run workflow*; tick *force* to rebuild a commit that is already built.
