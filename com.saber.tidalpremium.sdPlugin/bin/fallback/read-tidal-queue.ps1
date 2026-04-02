param(
    [string]$ProcessName = "TIDAL"
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

    $history = Get-SectionAnchor -Nodes $nodes -Name "History"
    $playingFrom = Get-SectionAnchor -Nodes $nodes -Name "Playing from:"
    $nextUp = Get-SectionAnchor -Nodes $nodes -Name "Next Up from:"

    if (-not $history -and -not $nextUp) {
        [Console]::Out.WriteLine((@{
                    ok      = $true
                    visible = $false
                } | ConvertTo-Json -Compress))
        exit 0
    }

    $previous = if ($history) { Get-RowPreview -Nodes $nodes -StartIndex $history.Index } else { $null }
    $current = if ($playingFrom) { Get-RowPreview -Nodes $nodes -StartIndex $playingFrom.Index } else { $null }
    $next = if ($nextUp) { Get-RowPreview -Nodes $nodes -StartIndex $nextUp.Index } else { $null }

    [Console]::Out.WriteLine((@{
                ok      = $true
                visible = $true
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
