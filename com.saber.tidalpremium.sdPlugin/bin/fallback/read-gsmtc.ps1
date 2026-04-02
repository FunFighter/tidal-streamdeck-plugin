param(
    [string]$AppFilter = "TIDAL"
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

function Get-ArtworkPath {
    param(
        [Parameter(Mandatory = $true)]
        [object]$MediaProperties,
        [Parameter(Mandatory = $true)]
        [string]$ArtworkHash
    )

    if (-not $MediaProperties.Thumbnail) {
        return @{
            artworkPath = $null
            artworkContentType = $null
        }
    }

    try {
        $stream = Await-WinRT $MediaProperties.Thumbnail.OpenReadAsync() ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $targetPath = Join-Path $env:TEMP ("tidalpremium_art_" + $ArtworkHash + ".png")
        $asStreamMethod = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() |
            Where-Object { $_.Name -eq "AsStream" -and $_.GetParameters().Count -eq 1 } |
            Select-Object -First 1
        $netStream = $asStreamMethod.Invoke($null, @($stream))
        $fileStream = [System.IO.File]::Open($targetPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)

        try {
            $netStream.CopyTo($fileStream)
        } finally {
            $fileStream.Dispose()
            $netStream.Dispose()
        }

        return @{
            artworkPath = $targetPath
            artworkContentType = "image/png"
        }
    } catch {
        return @{
            artworkPath = $null
            artworkContentType = $null
        }
    }
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
                    ok     = $true
                    active = $false
                } | ConvertTo-Json -Compress))
        exit 0
    }

    $playback = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()
    $media = Await-WinRT $session.TryGetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $hashSource = ($media.Title + "|" + $media.Artist + "|" + $media.AlbumTitle)
    $artworkHash = [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA1]::Create().ComputeHash(
            [System.Text.Encoding]::UTF8.GetBytes($hashSource)
        )
    ).Replace("-", "").ToLower().Substring(0, 12)
    $artwork = Get-ArtworkPath -MediaProperties $media -ArtworkHash $artworkHash

    [Console]::Out.WriteLine((@{
                ok                 = $true
                active             = $true
                appId              = $session.SourceAppUserModelId
                title              = $media.Title
                artist             = $media.Artist
                album              = $media.AlbumTitle
                playbackStatus     = $playback.PlaybackStatus.ToString().ToLower()
                positionMs         = [math]::Round($timeline.Position.TotalMilliseconds)
                durationMs         = [math]::Round($timeline.EndTime.TotalMilliseconds)
                artworkHash        = $artworkHash
                artworkPath        = $artwork.artworkPath
                artworkContentType = $artwork.artworkContentType
            } | ConvertTo-Json -Compress))
} catch {
    [Console]::Out.WriteLine((@{
                ok     = $false
                active = $false
                error  = $_.Exception.Message
            } | ConvertTo-Json -Compress))
    exit 1
}
