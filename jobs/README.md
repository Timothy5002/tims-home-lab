# Jobs

Each `<name>.sh` in this folder is a job the dispatcher can run via `POST /run/<name>`. Nothing outside this folder can be run. To add one, follow [../docs/adding-jobs.md](../docs/adding-jobs.md).

Rules: lowercase letters, digits and hyphens in the name; executable (`chmod +x`); no arguments or request data; exit 0 on success; finish within 60 seconds.

| Job | What it does | Scheduled |
|---|---|---|
| `hello` | Prints a greeting with the hostname and time; proves the pipeline works | Daily 06:00 (`com.lab.schedule.hello`) |
