# PowerShell version of scripts/psql.sh: run psql inside the Postgres container.
#   .\scripts\psql.ps1 -c "select count(*) from papers"
#   Get-Content db\tests\001_schema_test.sql -Raw | .\scripts\psql.ps1
Set-Location (Split-Path $PSScriptRoot -Parent)

# Read POSTGRES_USER / POSTGRES_DB from .env (same defaults as docker-compose.yml).
$cfg = @{ POSTGRES_USER = 'app'; POSTGRES_DB = 'papers' }
if (Test-Path .env) {
    Get-Content .env | Where-Object { $_ -match '^\s*(POSTGRES_USER|POSTGRES_DB)\s*=\s*(.+?)\s*$' } |
        ForEach-Object { $cfg[$Matches[1]] = $Matches[2] }
}

# Send piped text to docker as UTF-8 (Windows PowerShell 5.1 defaults to ASCII).
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$psqlArgs = @('-X', '-v', 'ON_ERROR_STOP=1', '-U', $cfg.POSTGRES_USER, '-d', $cfg.POSTGRES_DB) + $args
if ($MyInvocation.ExpectingInput) {
    $input | docker compose exec -T db psql @psqlArgs
} else {
    docker compose exec -T db psql @psqlArgs
}
exit $LASTEXITCODE
