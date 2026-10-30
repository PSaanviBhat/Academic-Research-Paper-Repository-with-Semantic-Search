# PowerShell version of scripts/rebuild_db.sh.
# Drops the whole "public" schema, then applies every numbered migration in db/ in order.
#   .\scripts\rebuild_db.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$psql = Join-Path $PSScriptRoot 'psql.ps1'

docker compose up -d --wait db
if ($LASTEXITCODE -ne 0) { throw 'Postgres container did not start' }

Write-Host "==> Dropping and recreating schema 'public'"
& $psql -q -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
if ($LASTEXITCODE -ne 0) { throw 'Schema reset failed' }

$migrations = Get-ChildItem db -File | Where-Object { $_.Name -match '^\d{3}_.*\.sql$' } | Sort-Object Name
if (-not $migrations) { throw 'No migrations found in db/' }
$migrations | ForEach-Object {
    Write-Host "==> Applying db/$($_.Name)"
    Get-Content $_.FullName -Raw | & $psql -q
    if ($LASTEXITCODE -ne 0) { throw "Migration $($_.Name) failed" }
}

Write-Host '==> Done. Tables now in the database:'
& $psql -c '\dt'
