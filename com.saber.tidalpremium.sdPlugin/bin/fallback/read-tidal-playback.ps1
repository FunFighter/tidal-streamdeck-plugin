param(
    [string]$ProcessName = "TIDAL"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Convert-TimeLabelToMilliseconds {
    param([string]$Value)

    $label = ([string]$Value).Trim()
    if (-not $label) {
        return 0
    }

    $parts = $label.Split(":")
    if ($parts.Count -eq 2) {
        return ((([int]$parts[0] * 60) + [int]$parts[1]) * 1000)
    }

    if ($parts.Count -eq 3) {
        return (((([int]$parts[0] * 60) + [int]$parts[1]) * 60) + [int]$parts[2]) * 1000
    }

    return 0
}

function Get-TimeNodes {
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
        $name = ([string]$element.Current.Name).Trim()
        if (-not $name -or $element.Current.IsOffscreen) {
            continue
        }

        if ($name -notmatch '^\d{1,2}:\d{2}$' -and $name -notmatch '^\d{1,2}:\d{2}:\d{2}$') {
            continue
        }

        $rect = $element.Current.BoundingRectangle
        $nodes += [pscustomobject]@{
            Name = $name
            Left = [double]$rect.Left
            Top = [double]$rect.Top
        }
    }

    return $nodes
}

try {
    $process = Get-Process $ProcessName -ErrorAction Stop |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1

    if (-not $process) {
        [Console]::Out.WriteLine((@{
                    ok = $true
                    active = $false
                    visible = $false
                } | ConvertTo-Json -Compress))
        exit 0
    }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $nodes = Get-TimeNodes -Root $root
    if ($nodes.Count -lt 2) {
        [Console]::Out.WriteLine((@{
                    ok = $true
                    active = $true
                    visible = $false
                } | ConvertTo-Json -Compress))
        exit 0
    }

    $rows = $nodes |
        Group-Object { [int][Math]::Round($_.Top / 8.0) } |
        ForEach-Object {
            $rowNodes = $_.Group | Sort-Object Left
            $left = ($rowNodes | Measure-Object -Property Left -Minimum).Minimum
            $right = ($rowNodes | Measure-Object -Property Left -Maximum).Maximum
            $top = ($rowNodes | Measure-Object -Property Top -Maximum).Maximum

            [pscustomobject]@{
                Nodes = $rowNodes
                Count = $rowNodes.Count
                Spread = [double]($right - $left)
                Top = [double]$top
            }
        } |
        Where-Object { $_.Count -ge 2 } |
        Sort-Object @{ Expression = "Spread"; Descending = $true }, @{ Expression = "Top"; Descending = $true }

    $row = $rows | Select-Object -First 1
    if (-not $row) {
        [Console]::Out.WriteLine((@{
                    ok = $true
                    active = $true
                    visible = $false
                } | ConvertTo-Json -Compress))
        exit 0
    }

    $current = $row.Nodes | Select-Object -First 1
    $total = $row.Nodes | Select-Object -Last 1
    $positionMs = Convert-TimeLabelToMilliseconds $current.Name
    $durationMs = Convert-TimeLabelToMilliseconds $total.Name

    [Console]::Out.WriteLine((@{
                ok = $true
                active = $true
                visible = ($durationMs -gt 0)
                positionMs = $positionMs
                durationMs = $durationMs
                positionLabel = $current.Name
                durationLabel = $total.Name
            } | ConvertTo-Json -Compress))
} catch {
    [Console]::Out.WriteLine((@{
                ok = $false
                active = $false
                visible = $false
                error = $_.Exception.Message
            } | ConvertTo-Json -Compress))
    exit 1
}
