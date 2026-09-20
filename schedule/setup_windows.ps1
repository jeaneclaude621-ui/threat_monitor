# Windows Task Scheduler setup for the Hybrid Threat Monitor
#
# Run this once from an elevated PowerShell prompt, from inside the
# threat_monitor folder. It creates two scheduled tasks:
#   1. "ThreatMonitor-Hourly"  - runs every hour, all day
#   2. "ThreatMonitor-Daily"   - runs once at 05:00
#
# Edit $ProjectPath and $PythonExe if your setup differs.

$ProjectPath = (Get-Location).Path
$PythonExe = (Get-Command python).Source

# --- Hourly monitor ---
$HourlyAction = New-ScheduledTaskAction -Execute $PythonExe `
    -Argument "src\hourly_monitor.py" -WorkingDirectory $ProjectPath
$HourlyTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "ThreatMonitor-Hourly" `
    -Action $HourlyAction -Trigger $HourlyTrigger `
    -Description "Hybrid Threat Monitor: hourly narrative/correction check" -Force

# --- Daily 05:00 report ---
$DailyAction = New-ScheduledTaskAction -Execute $PythonExe `
    -Argument "src\daily_report.py" -WorkingDirectory $ProjectPath
$DailyTrigger = New-ScheduledTaskTrigger -Daily -At "05:00"
Register-ScheduledTask -TaskName "ThreatMonitor-Daily" `
    -Action $DailyAction -Trigger $DailyTrigger `
    -Description "Hybrid Threat Monitor: consolidated daily report" -Force

Write-Host "Done. Two tasks registered: ThreatMonitor-Hourly and ThreatMonitor-Daily."
Write-Host "NOTE: set ANTHROPIC_API_KEY as a permanent system environment variable first -"
Write-Host "      scheduled tasks won't see a key only set in your current shell session."
Write-Host "      System Properties > Environment Variables > New (System variable)."
