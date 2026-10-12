"""
Runs one scheduled job on whichever machine is the current runner, and
keeps the run state in step between the Mac and GitHub Actions.

The run state - data/ plus the text files in reports/ that later runs read
back (report_data.json, executive_sv.json) - lives in its own git repo,
.state.git, whose work tree is this project folder. The code repo ignores
those paths and the state repo tracks only them, so neither sees the
other's files and no code path changes. The .pptx decks (and the .m4a
files of the old spoken briefing) are left out: they are mailed and
uploaded, and nothing reads them back.

data/runner names the machine that runs the jobs ("mac" or "cloud"). A job
started anywhere else exits without doing anything, so moving the runs is
editing that one line and pushing it - and both machines can never send
the same report twice.

    python3 schedule/run_job.py --host mac daily
    python3 schedule/run_job.py --host cloud hourly

Each run: pull the state, check the runner, run the job with Stockholm
time, then commit and push what changed. With no remote configured the
state is only committed locally. If the pull fails the job does not run:
running on stale state could fork it or send a report twice.

Each machine writes its own log files (launchd: data/logs/*_run.log;
Actions: *_run_cloud.log). A pull then never rewrites a log the other
machine changed, which would conflict with this machine's unsaved lines or
cut off a log launchd holds open.

GitHub's schedule is in UTC and can start late, so Actions fires each job
at both UTC hours that can be its Stockholm hour, and passes --at with the
Stockholm hours the job is due. The run goes ahead only once a due hour
has come and no run has been started since it (data/last_run.json); the
other firing finds it done and skips. launchd starts on time and passes no
--at, but its runs are recorded too, so after a move nothing runs twice.

--test runs the job without touching the shared state: it ignores the
runner, keeps nothing and only checks that the push would be accepted.
The workflow pairs it with mail to the sender only, no app upload and a
reply check that leaves the mail unread.
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, time as clock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE_GIT = ROOT / ".state.git"
RUNNER_PATH = ROOT / "data" / "runner"
LAST_RUN_PATH = ROOT / "data" / "last_run.json"
BRANCH = "main"
TIMEZONE = "Europe/Stockholm"

JOBS = {
    "daily": ["src/daily_report.py"],
    "hourly": ["src/hourly_monitor.py"],
}

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
        # The other machine pushed meanwhile (the runner line, or an
        # overlapping run): replay this commit on top and try again.
        git("pull", "--quiet", "--rebase", "--autostash", "origin", BRANCH, check=False)
    log("! Could not push the state to GitHub - it is committed locally "
        "and goes up with the next run")


def current_runner() -> str:
    try:
        return RUNNER_PATH.read_text().strip() or "mac"
    except FileNotFoundError:
        return "mac"


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True, choices=["mac", "cloud"])
    ap.add_argument("--at", help="Stockholm hours the job is due, e.g. 1,16")
    ap.add_argument("--test", action="store_true",
                    help="ignore the runner and keep no state")
    ap.add_argument("job", choices=sorted(JOBS))
    args = ap.parse_args()
    os.environ["TZ"] = TIMEZONE
    time.tzset()

    ensure_state_repo()
    with state_lock():
        if not pull():
            return 1
    now = datetime.now()
    if not args.test:
        runner = current_runner()
        if runner != args.host:
            log(f"{args.job} skipped - the jobs run on '{runner}', this is '{args.host}'")
            return 0
        if args.at:
            reason = due_reason(args.job, [int(h) for h in args.at.split(",")], now)
            if reason:
                log(f"{args.job} skipped - {reason}")
                return 0
        record_start(args.job, args.host, now)
        # Saved before the job runs, so a run that is killed outright
        # still counts as started.
        with state_lock():
            commit_and_push(f"{args.job} on {args.host} {now:%Y-%m-%d %H:%M} started")
    else:
        log(f"TEST run of {args.job} - nothing is saved")

    code = subprocess.run([sys.executable, *JOBS[args.job]], cwd=ROOT).returncode
    if code != 0:
        log(f"! {args.job} exited with code {code}")

    if args.test:
        if has_remote():
            r = git("push", "--dry-run", "origin", f"HEAD:{BRANCH}", check=False)
            log("Push access to the state repo: "
                + ("OK" if r.returncode == 0 else f"FAILED - {r.stderr.strip()[:300]}"))
        return code

    with state_lock():
        commit_and_push(f"{args.job} on {args.host} {now:%Y-%m-%d %H:%M}"
                        + ("" if code == 0 else f" (exit {code})"))
    return code


if __name__ == "__main__":
    sys.exit(main())
