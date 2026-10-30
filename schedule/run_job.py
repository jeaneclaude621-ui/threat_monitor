"""
Runs one scheduled job on GitHub Actions between pulling and pushing
the run state.

The run state - data/ plus the text files in reports/ that later runs read
back (report_data.json, executive_sv.json) - lives in its own git repo,
.state.git, whose work tree is this project folder. The code repo ignores
those paths and the state repo tracks only them, so neither sees the
other's files and no code path changes. The .pptx decks (and the .m4a
files of the old spoken briefing) are left out: they are mailed and
uploaded, and nothing reads them back.

    python3 schedule/run_job.py --at 4 daily
    python3 schedule/run_job.py invites

Each run: pull the state, run the job with Stockholm time, then commit and
push what changed. With no remote configured the state is only committed
locally. If the pull fails the job does not run: running on stale state
could fork it or send a report twice.

GitHub's schedule is in UTC and can start late, so Actions fires each job
at both UTC hours that can be its Stockholm hour, and passes --at with the
Stockholm hours the job is due. The run goes ahead only once a due hour
has come and no run has been started since it (data/last_run.json); the
other firing finds it done and skips.

"invites" (mail the app invitations queued in the Worker) runs every five
minutes and
quietly: it is not recorded in last_run.json or on the status page, and
it commits only when someone was mailed.

--test runs the job without touching the shared state: it keeps nothing
and only checks that the push would be accepted.
The workflow pairs it with mail to the sender only, no app upload and a
reply check that leaves the mail unread.

Every real run is reported to the app (PUT /api/ingest/runs/<id>) when it
starts and when it ends, with the job's "!" warning lines, for the status
page's green/yellow/red lights.
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, time as clock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE_GIT = ROOT / ".state.git"
LAST_RUN_PATH = ROOT / "data" / "last_run.json"

sys.path.insert(0, str(ROOT / "src"))
BRANCH = "main"
TIMEZONE = "Europe/Stockholm"

JOBS = {
    "daily": ["src/daily_report.py"],
    "hourly": ["src/hourly_monitor.py"],
    "invites": ["src/app_mail.py", "send-invites"],
}
QUIET_JOBS = {"invites"}
HOST = "cloud"

# What the state repo tracks, as git pathspecs. Named at every add rather
# than kept in an exclude file: the code repo's .gitignore sits in the same
# work tree and ignores data/ and reports/, and it would win over one.
STATE_PATHS = [
    "data", "reports",
    ":(exclude)reports/*.pptx", ":(exclude)reports/*.m4a",
    ":(exclude)reports/superseded", ":(exclude,glob)**/.DS_Store",
    ":(exclude,glob)**/__pycache__",
]

def log(msg: str):
    print(f"[run_job {datetime.now():%Y-%m-%dT%H:%M}] {msg}", flush=True)


def git(*args, check=True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", f"--git-dir={STATE_GIT}", f"--work-tree={ROOT}", *args],
        cwd=ROOT, check=check, capture_output=True, text=True)


@contextmanager
def state_lock():
    """Serialises git operations on the state repo between jobs that
    overlap on one machine. Held only around git, never around a job."""
    with open(STATE_GIT / "run_job.lock", "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def ensure_state_repo():
    if not STATE_GIT.exists():
        subprocess.run(["git", "init", "--quiet", "--bare", f"--initial-branch={BRANCH}",
                        str(STATE_GIT)], check=True, capture_output=True)
        git("config", "core.bare", "false")
        log("Created the state repo .state.git")
    # Keep git status to the tracked files instead of the whole project.
    git("config", "status.showUntrackedFiles", "no")


def has_remote() -> bool:
    return bool(git("remote", check=False).stdout.strip())


def pull() -> bool:
    if not has_remote():
        return True
    r = git("pull", "--quiet", "--rebase", "--autostash", "origin", BRANCH, check=False)
    if r.returncode != 0:
        log(f"! Could not pull the state from GitHub: {(r.stderr or r.stdout).strip()[:300]}")
        return False
    return True


def commit_and_push(message: str):
    # A pathspec that matches nothing is an error; a fresh machine may not
    # have every folder yet.
    paths = [p for p in STATE_PATHS if p.startswith(":") or (ROOT / p).exists()]
    git("add", "--all", "--force", "--", *paths)
    if git("diff", "--cached", "--quiet", check=False).returncode == 0:
        return
    git("commit", "--quiet", "-m", message)
    if not has_remote():
        return
    for _ in range(3):
        if git("push", "--quiet", "origin", f"HEAD:{BRANCH}", check=False).returncode == 0:
            return
        # An overlapping run pushed meanwhile: replay this commit on top
        # and try again.
        git("pull", "--quiet", "--rebase", "--autostash", "origin", BRANCH, check=False)
    log("! Could not push the state to GitHub - it is committed locally "
        "and goes up with the next run")


def load_last_run() -> dict:
    try:
        return json.loads(LAST_RUN_PATH.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def record_start(job: str, host: str, now: datetime):
    """Written when a job starts, whatever its outcome: a job that fails
    after mailing the report must not be run again by the next firing."""
    runs = load_last_run()
    runs[job] = {"started": now.isoformat(timespec="seconds"), "host": host}
    LAST_RUN_PATH.write_text(json.dumps(runs, indent=2, sort_keys=True) + "\n")


def due_reason(job: str, hours: list, now: datetime):
    """None if the job is due now, else why it is not."""
    passed = [datetime.combine(now.date(), clock(h)) for h in hours if h <= now.hour]
    if not passed:
        return f"not due before {min(hours):02d}:00"
    slot = max(passed)
    last = load_last_run().get(job, {}).get("started")
    if last and datetime.fromisoformat(last) >= slot:
        return f"the {slot:%H:%M} run already started at {last[11:16]}"
    return None


def run_and_watch(script: list) -> tuple:
    """Runs the job with its output passed straight through, and returns
    (exit code, the job's warning lines - those starting with "!")."""
    proc = subprocess.Popen([sys.executable, *script], cwd=ROOT, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=dict(os.environ, PYTHONUNBUFFERED="1"))
    warnings = []
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        if line.lstrip().startswith("!") and len(warnings) < 50:
            warnings.append(line.strip()[:500])
    return proc.wait(), warnings


def report_run(run: dict):
    try:
        from app_sync import push_run
        push_run(run)
    except Exception as e:  # the status page must never stop a run
        log(f"! Run status upload failed: {e}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--at", help="Stockholm hours the job is due, e.g. 1,16")
    ap.add_argument("--test", action="store_true",
                    help="keep no state")
    ap.add_argument("job", choices=sorted(JOBS))
    args = ap.parse_args()
    os.environ["TZ"] = TIMEZONE
    time.tzset()

    ensure_state_repo()
    with state_lock():
        if not pull():
            return 1
    now = datetime.now()
    if args.job in QUIET_JOBS:
        code, _ = run_and_watch(JOBS[args.job])
        if not args.test:
            with state_lock():
                commit_and_push(f"{args.job} {now:%Y-%m-%d %H:%M}")
        return code
    if not args.test:
        if args.at:
            reason = due_reason(args.job, [int(h) for h in args.at.split(",")], now)
            if reason:
                log(f"{args.job} skipped - {reason}")
                return 0
        record_start(args.job, HOST, now)
        # Saved before the job runs, so a run that is killed outright
        # still counts as started.
        with state_lock():
            commit_and_push(f"{args.job} on {HOST} {now:%Y-%m-%d %H:%M} started")
    else:
        log(f"TEST run of {args.job} - nothing is saved")

    run = {"id": uuid.uuid4().hex, "job": args.job, "host": HOST,
           "started_at": now.astimezone().isoformat(timespec="seconds"), "status": "running"}
    gh = [os.environ.get(k) for k in ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID")]
    if all(gh):
        run["log_url"] = "{}/{}/actions/runs/{}".format(*gh)
    if not args.test:
        report_run(run)

    code, warnings = run_and_watch(JOBS[args.job])
    if code != 0:
        log(f"! {args.job} exited with code {code}")
    if not args.test:
        report_run(dict(run, status="ok" if code == 0 else "failed", exit_code=code, warnings=warnings,
                        finished_at=datetime.now().astimezone().isoformat(timespec="seconds")))

    if args.test:
        if has_remote():
            r = git("push", "--dry-run", "origin", f"HEAD:{BRANCH}", check=False)
            log("Push access to the state repo: "
                + ("OK" if r.returncode == 0 else f"FAILED - {r.stderr.strip()[:300]}"))
        return code

    with state_lock():
        commit_and_push(f"{args.job} on {HOST} {now:%Y-%m-%d %H:%M}"
                        + ("" if code == 0 else f" (exit {code})"))
    return code


if __name__ == "__main__":
    sys.exit(main())
