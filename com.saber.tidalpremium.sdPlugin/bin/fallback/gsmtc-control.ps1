param(
    [string]$AppFilter = "TIDAL",
    [ValidateSet("togglePlayPause", "nextTrack", "previousTrack")]
    [string]$Action = "togglePlayPause"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$script:AsTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1

function Await-WinRT {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Operation,
        [Parameter(Mandatory = $true)]
        [Type]$ResultType
    )

    $method = $script:AsTaskMethod.MakeGenericMethod($ResultType)
    $task = $method.Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

try {
    $manager = Await-WinRT (
        [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]::RequestAsync()
    ) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    $session = $manager.GetSessions() |
        Where-Object { $_.SourceAppUserModelId -match $AppFilter } |
        Select-Object -First 1

    if (-not $session) {
        [Console]::Out.WriteLine((@{
                    ok        = $true
                    performed = $false
                    reason    = "no-session"
                } | ConvertTo-Json -Compress))
        exit 0
    }

    switch ($Action) {
        "togglePlayPause" {
            $performed = Await-WinRT $session.TryTogglePlayPauseAsync() ([bool])
        }
        "nextTrack" {
            $performed = Await-WinRT $session.TrySkipNextAsync() ([bool])
        }
        "previousTrack" {
            $performed = Await-WinRT $session.TrySkipPreviousAsync() ([bool])
        }
    }

    [Console]::Out.WriteLine((@{
                ok        = $true
                performed = [bool]$performed
            } | ConvertTo-Json -Compress))
} catch {
    [Console]::Out.WriteLine((@{
                ok        = $false
                performed = $false
                error     = $_.Exception.Message
            } | ConvertTo-Json -Compress))
    exit 1
}
