# PowerShell version of scripts/run_tests.sh.
# Runs every SQL test in db/tests (files starting with "_" are helpers, not tests).
#   .\scripts\run_tests.ps1
Set-Location (Split-Path $PSScriptRoot -Parent)
$psql = Join-Path $PSScriptRoot 'psql.ps1'
$helpers = Get-Content db\tests\_helpers.sql -Raw
$failed = $false

$tests = Get-ChildItem db\tests -File | Where-Object { $_.Name -match '^\d.*\.sql$' } | Sort-Object Name
if (-not $tests) { Write-Host 'No tests found in db/tests'; exit 1 }
$tests | ForEach-Object {
    Write-Host ""
    Write-Host "################ db/tests/$($_.Name) ################"
    # psql runs inside the container, so helpers + test are piped in as one stream.
    $out = ($helpers + "`n" + (Get-Content $_.FullName -Raw)) | & $psql 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $out
    if ($code -ne 0 -or $out -cmatch '\bFAIL\b') {
        Write-Host "!!! db/tests/$($_.Name) FAILED"
        $failed = $true
    }
}

Write-Host ""
if ($failed) { Write-Host 'SOME TESTS FAILED'; exit 1 } else { Write-Host 'ALL TESTS PASSED' }
