param(
  [Parameter(Mandatory = $true)]
  [int]$TargetProcessId,
  [int]$DurationSeconds = 600,
  [double]$IntervalSeconds = 1,
  [int]$TrimAtSeconds = -1,
  [string]$Label = 'run',
  [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'

if ($OutputPath -eq '') {
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $OutputPath = Join-Path $PWD ".tmp/memory/$Label-$timestamp.csv"
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) {
  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

if (-not ('ZyCodeMemory.NativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ZyCodeMemory {
  public static class NativeMethods {
    [DllImport("psapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EmptyWorkingSet(IntPtr processHandle);
  }
}
'@
}

$samples = [System.Collections.Generic.List[object]]::new()
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$trimAttempted = $false
$trimSucceeded = $false

function Add-MemorySample {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$Phase
  )

  $Process.Refresh()
  $samples.Add([pscustomobject]@{
      label = $Label
      timestamp = (Get-Date).ToString('o')
      elapsed_seconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
      phase = $Phase
      working_set_mb = [math]::Round($Process.WorkingSet64 / 1MB, 3)
      private_bytes_mb = [math]::Round($Process.PrivateMemorySize64 / 1MB, 3)
      virtual_bytes_mb = [math]::Round($Process.VirtualMemorySize64 / 1MB, 3)
      paged_bytes_mb = [math]::Round($Process.PagedMemorySize64 / 1MB, 3)
      peak_working_set_mb = [math]::Round($Process.PeakWorkingSet64 / 1MB, 3)
      handles = $Process.HandleCount
      threads = $Process.Threads.Count
      trim_succeeded = $trimSucceeded
    })
}

try {
  $targetProcess = Get-Process -Id $TargetProcessId -ErrorAction Stop

  while ($stopwatch.Elapsed.TotalSeconds -le $DurationSeconds -and -not $targetProcess.HasExited) {
    if (-not $trimAttempted -and $TrimAtSeconds -ge 0 -and
      $stopwatch.Elapsed.TotalSeconds -ge $TrimAtSeconds) {
      Add-MemorySample -Process $targetProcess -Phase 'pre_trim'
      $trimAttempted = $true
      # 跨完整性级别采样时可能能读取计数器，却拿不到可用于 P/Invoke 的句柄。
      # 此时继续记录曲线并标记 trim 失败，不能让整轮 CSV 在中点中断。
      $processHandle = $targetProcess.Handle
      if ($null -eq $processHandle -or $processHandle -eq [IntPtr]::Zero) {
        $trimSucceeded = $false
      } else {
        $trimSucceeded = [ZyCodeMemory.NativeMethods]::EmptyWorkingSet([IntPtr]$processHandle)
      }
      Start-Sleep -Milliseconds 100
      Add-MemorySample -Process $targetProcess -Phase 'post_trim'
    } else {
      Add-MemorySample -Process $targetProcess -Phase 'sample'
    }

    Start-Sleep -Milliseconds ([math]::Max(100, [int]($IntervalSeconds * 1000)))
  }
} finally {
  $samples | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding utf8
  Write-Output "Memory samples written to: $OutputPath"
  Write-Output "Samples: $($samples.Count); trim attempted: $trimAttempted; trim succeeded: $trimSucceeded"
}
