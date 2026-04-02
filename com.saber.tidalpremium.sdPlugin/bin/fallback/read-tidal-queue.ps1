param(
    [string]$ProcessName = "TIDAL",
    [string]$CurrentTitle = "",
    [string]$CurrentArtist = "",
    [string]$CurrentAlbum = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

function Normalize-Text {
    param([string]$Value)
    return ([string]$Value).Trim().ToLowerInvariant()
}

function Has-Text {
    param([string]$Value)
    return -not [string]::IsNullOrWhiteSpace(([string]$Value))
}

function Is-NoiseText {
    param([string]$Value)

    $text = ([string]$Value).Trim()
    if (-not $text) {
        return $true
    }

    if ($text -eq "Play" -or $text -eq "Mix" -or $text -eq "Tracks" -or $text -eq "Show options") {
        return $true
    }

    if ($text -match "^\d+:\d{2}$") {
        return $true
    }

    if ($text -match "^\d+\s+Play$") {
        return $true
    }

    return $false
}

function Test-TextMatch {
    param(
        [string]$Left,
        [string]$Right
    )

    $leftText = Normalize-Text $Left
    $rightText = Normalize-Text $Right

    if (-not $leftText -or -not $rightText) {
        return $false
    }

    return $leftText -eq $rightText -or $leftText.Contains($rightText) -or $rightText.Contains($leftText)
}

function Join-UniqueText {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Nodes,
        [double]$MinLeft,
        [double]$MaxLeft
    )

    $values = $Nodes |
        Where-Object {
            $_.Name -and
            $_.Left -ge $MinLeft -and
            $_.Left -lt $MaxLeft -and
            -not (Is-NoiseText $_.Name)
        } |
        Sort-Object Left, Index |
        ForEach-Object { $_.Name }

    $unique = New-Object System.Collections.Generic.List[string]
    foreach ($value in $values) {
        if (-not ($unique | Where-Object { (Normalize-Text $_) -eq (Normalize-Text $value) } | Select-Object -First 1)) {
            $unique.Add($value)
        }
    }

    return ($unique -join " ").Trim()
}

function Get-FirstText {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Nodes,
        [double]$MinLeft,
        [double]$MaxLeft
    )

    $match = $Nodes |
        Where-Object {
            $_.Name -and
            $_.Left -ge $MinLeft -and
            $_.Left -lt $MaxLeft -and
            -not (Is-NoiseText $_.Name)
        } |
        Sort-Object Left, Index |
        Select-Object -First 1

    if ($match) {
        return ([string]$match.Name).Trim()
    }

    return ""
}

function Get-VisibleNodes {
    param(
        [Parameter(Mandatory = $true)]
        [System.Windows.Automation.AutomationElement]$Root
    )

    $elements = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )

    $nodes = @()
    for ($index = 0; $index -lt $elements.Count; $index += 1) {
        $element = $elements.Item($index)
        $rect = $element.Current.BoundingRectangle

        $nodes += [pscustomobject]@{
            Index        = $index
            Element      = $element
            Name         = [string]$element.Current.Name
            AutomationId = [string]$element.Current.AutomationId
            Type         = [string]$element.Current.ControlType.ProgrammaticName
            IsOffscreen  = [bool]$element.Current.IsOffscreen
            Left         = [double]$rect.Left
            Top          = [double]$rect.Top
            Width        = [double]$rect.Width
            Height       = [double]$rect.Height
        }
    }

    return $nodes
}

function Get-SectionAnchor {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Nodes,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return $Nodes |
        Where-Object { -not $_.IsOffscreen -and $_.Name -eq $Name } |
        Select-Object -First 1
}

function Get-PlayQueueButton {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Nodes
    )

    return $Nodes |
        Where-Object {
            -not $_.IsOffscreen -and
            $_.Name -eq "Play queue" -and
            $_.Type -eq "ControlType.Button"
        } |
        Select-Object -First 1
}

function New-ArtworkHash {
    param(
        [string]$Title,
        [string]$Artist,
        [string]$Album
    )

    $hashSource = ($Title + "|" + $Artist + "|" + $Album)
    return [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA1]::Create().ComputeHash(
            [System.Text.Encoding]::UTF8.GetBytes($hashSource)
        )
    ).Replace("-", "").ToLower().Substring(0, 12)
}

function Save-RowArtwork {
    param(
        [double]$Left,
        [double]$Top,
        [double]$Width,
        [double]$Height,
        [string]$ArtworkHash
    )

    if ($Width -lt 12 -or $Height -lt 12) {
        return @{
            artworkPath = $null
            artworkHash = $null
            artworkContentType = $null
        }
    }

    $targetPath = Join-Path $env:TEMP ("tidalpremium_queue_" + $ArtworkHash + ".png")
    $bmp = New-Object System.Drawing.Bitmap ([int][Math]::Round($Width)), ([int][Math]::Round($Height))
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)

    try {
        $graphics.CopyFromScreen(
            ([int][Math]::Round($Left)),
            ([int][Math]::Round($Top)),
            0,
            0,
            $bmp.Size
        )
        $bmp.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bmp.Dispose()
    }

    return @{
        artworkPath = $targetPath
        artworkHash = $ArtworkHash
        artworkContentType = "image/png"
    }
}

function Get-RowPreview {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Nodes,
        [Parameter(Mandatory = $true)]
        [int]$StartIndex
    )

    $anchor = $Nodes | Where-Object { $_.Index -eq $StartIndex } | Select-Object -First 1
    if (-not $anchor) {
        return $null
    }

    $row = $Nodes |
        Where-Object {
            $_.Index -gt $StartIndex -and
            -not $_.IsOffscreen -and
            $_.Type -eq "ControlType.DataItem" -and
            $_.Width -ge 160 -and
            $_.Height -ge 32 -and
            $_.Top -ge ($anchor.Top + 12)
        } |
        Select-Object -First 1

    if (-not $row) {
        return $null
    }

    $rowBottom = $row.Top + [Math]::Max($row.Height, 44) + 6
    $rowLeft = $row.Left

    $titleNode = $Nodes |
        Where-Object {
            $_.Index -gt $StartIndex -and
            -not $_.IsOffscreen -and
            $_.Type -eq "ControlType.Hyperlink" -and
            $_.Name -and
            $_.Name -ne "Mix" -and
            $_.Name -ne "Tracks" -and
            $_.Top -ge ($row.Top - 2) -and
            $_.Top -le $rowBottom -and
            $_.Left -ge ($rowLeft + 40)
        } |
        Sort-Object Top, Left, Index |
        Select-Object -First 1

    if (-not $titleNode) {
        return $null
    }

    $artistNode = $Nodes |
        Where-Object {
            $_.Index -gt $titleNode.Index -and
            -not $_.IsOffscreen -and
            $_.Type -eq "ControlType.Hyperlink" -and
            $_.Name -and
            $_.Name -ne "Mix" -and
            $_.Name -ne "Tracks" -and
            $_.Top -gt $titleNode.Top -and
            $_.Top -le $rowBottom -and
            $_.Left -ge ($rowLeft + 40)
        } |
        Sort-Object Top, Left, Index |
        Select-Object -First 1

    $artNode = $Nodes |
        Where-Object {
            $_.Index -gt $StartIndex -and
            $_.Index -lt $titleNode.Index -and
            -not $_.IsOffscreen -and
            $_.Width -ge 32 -and $_.Width -le 80 -and
            $_.Height -ge 32 -and $_.Height -le 80 -and
            $_.Top -ge ($row.Top - 4) -and
            $_.Top -le ($rowBottom - 12)
        } |
        Sort-Object Top, Left, Index |
        Select-Object -First 1

    $artworkHash = New-ArtworkHash -Title $titleNode.Name -Artist $(if ($artistNode) { $artistNode.Name } else { "" }) -Album ""
    $artwork = if ($artNode) {
        Save-RowArtwork -Left $artNode.Left -Top $artNode.Top -Width $artNode.Width -Height $artNode.Height -ArtworkHash $artworkHash
    } else {
        @{
            artworkPath = $null
            artworkHash = $null
            artworkContentType = $null
        }
    }

    return [pscustomobject]@{
        title              = $titleNode.Name
        artist             = if ($artistNode) { $artistNode.Name } else { "" }
        album              = ""
        artworkPath        = $artwork.artworkPath
        artworkHash        = $artwork.artworkHash
        artworkContentType = $artwork.artworkContentType
    }
}

function Get-VisibleQueueRows {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Nodes
    )

    $titleCandidates = $Nodes |
        Where-Object {
            -not $_.IsOffscreen -and
            $_.Type -eq "ControlType.DataItem" -and
            $_.Name -and
            $_.Left -ge 500 -and
            $_.Left -lt 860 -and
            $_.Width -ge 120 -and
            $_.Height -ge 28 -and
            $_.Top -ge 540 -and
            -not (Is-NoiseText $_.Name)
        } |
        Sort-Object Top, Left, Index

    $rows = New-Object System.Collections.Generic.List[object]
    $rowTops = New-Object System.Collections.Generic.List[double]

    foreach ($candidate in $titleCandidates) {
        $existingTop = $rowTops | Where-Object { [Math]::Abs($_ - $candidate.Top) -le 6 } | Select-Object -First 1
        if ($null -ne $existingTop) {
            continue
        }

        $rowTops.Add($candidate.Top)
    }

    foreach ($rowTop in ($rowTops | Sort-Object)) {
        $rowNodes = $Nodes |
            Where-Object {
                -not $_.IsOffscreen -and
                $_.Top -ge ($rowTop - 4) -and
                $_.Top -le ($rowTop + 24) -and
                $_.Left -ge 500 -and
                $_.Left -lt 1338 -and
                $_.Name
            }

        $title = Get-FirstText -Nodes $rowNodes -MinLeft 520 -MaxLeft 805
        $artist = Get-FirstText -Nodes $rowNodes -MinLeft 805 -MaxLeft 1029
        $album = Get-FirstText -Nodes $rowNodes -MinLeft 1029 -MaxLeft 1195

        if (-not (Has-Text $title)) {
            continue
        }

        $rows.Add([pscustomobject]@{
                title              = $title
                artist             = $artist
                album              = $album
                artworkPath        = $null
                artworkHash        = $null
                artworkContentType = $null
            })
    }

    return $rows
}

function Find-QueueRowIndex {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Rows,
        [string]$Title,
        [string]$Artist,
        [string]$Album
    )

    if (-not (Has-Text $Title)) {
        return -1
    }

    for ($index = 0; $index -lt $Rows.Count; $index += 1) {
        $row = $Rows[$index]
        $titleMatches = Test-TextMatch -Left $row.title -Right $Title
        $artistMatches =
            (-not (Has-Text $Artist)) -or
            (-not (Has-Text $row.artist)) -or
            (Test-TextMatch -Left $row.artist -Right $Artist)
        $albumMatches =
            (-not (Has-Text $Album)) -or
            (-not (Has-Text $row.album)) -or
            (Test-TextMatch -Left $row.album -Right $Album)

        if ($titleMatches -and $artistMatches -and $albumMatches) {
            return $index
        }
    }

    for ($index = 0; $index -lt $Rows.Count; $index += 1) {
        if (Test-TextMatch -Left $Rows[$index].title -Right $Title) {
            return $index
        }
    }

    return -1
}

try {
    $process = Get-Process $ProcessName -ErrorAction Stop |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1

    if (-not $process) {
        [Console]::Out.WriteLine((@{
                    ok      = $true
                    visible = $false
                } | ConvertTo-Json -Compress))
        exit 0
    }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $nodes = Get-VisibleNodes -Root $root

    $history = $null
    $playingFrom = $null
    $nextUp = $null
    $previous = $null
    $current = $null
    $next = $null
    $visible = $false

    for ($attempt = 0; $attempt -lt 2; $attempt += 1) {
        $history = Get-SectionAnchor -Nodes $nodes -Name "History"
        $playingFrom = Get-SectionAnchor -Nodes $nodes -Name "Playing from:"
        $nextUp = Get-SectionAnchor -Nodes $nodes -Name "Next Up from:"
        $previous = if ($history) { Get-RowPreview -Nodes $nodes -StartIndex $history.Index } else { $null }
        $current = if ($playingFrom) { Get-RowPreview -Nodes $nodes -StartIndex $playingFrom.Index } else { $null }
        $next = if ($nextUp) { Get-RowPreview -Nodes $nodes -StartIndex $nextUp.Index } else { $null }
        $visible = [bool]($history -or $playingFrom -or $nextUp)

        if (-not $visible) {
            $rows = @(Get-VisibleQueueRows -Nodes $nodes)
            $matchIndex = Find-QueueRowIndex -Rows $rows -Title $CurrentTitle -Artist $CurrentArtist -Album $CurrentAlbum

            if ($matchIndex -ge 0) {
                $visible = $true
                $current = $rows[$matchIndex]
                $previous = if ($matchIndex -gt 0) { $rows[$matchIndex - 1] } else { $null }
                $next = if (($matchIndex + 1) -lt $rows.Count) { $rows[$matchIndex + 1] } else { $null }
            }
        }

        if ($visible -or $attempt -gt 0 -or -not (Has-Text $CurrentTitle)) {
            break
        }

        $queueButton = Get-PlayQueueButton -Nodes $nodes
        if (-not $queueButton) {
            break
        }

        try {
            $toggle = $queueButton.Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) {
                $toggle.Toggle()
                Start-Sleep -Milliseconds 450
                $nodes = Get-VisibleNodes -Root $root
            } else {
                break
            }
        } catch {
            break
        }
    }

    [Console]::Out.WriteLine((@{
                ok      = $true
                visible = $visible
                previous = $previous
                current = $current
                next    = $next
            } | ConvertTo-Json -Compress -Depth 4))
} catch {
    [Console]::Out.WriteLine((@{
                ok      = $false
                visible = $false
                error   = $_.Exception.Message
            } | ConvertTo-Json -Compress))
    exit 1
}
