param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$releaseRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$archivePath=[IO.Path]::GetFullPath($Destination)
if($archivePath.StartsWith($releaseRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'ARCHIVE_MUST_BE_OUTSIDE_SOURCE'}
if(Test-Path -LiteralPath $archivePath){throw 'ARCHIVE_TARGET_EXISTS'}
$manifest=Get-Content -Raw -LiteralPath (Join-Path $releaseRoot 'FILE-MANIFEST.json') | ConvertFrom-Json
if(-not $manifest.audit.ok){throw 'RELEASE_AUDIT_REQUIRED'}
Add-Type -AssemblyName System.IO.Compression
$stream=[IO.File]::Open($archivePath,[IO.FileMode]::CreateNew)
$archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try{
 foreach($file in @($manifest.files)+@([pscustomobject]@{path='FILE-MANIFEST.json';sha256=$null})){
  $sourcePath=[IO.Path]::GetFullPath((Join-Path $releaseRoot $file.path))
  if(-not $sourcePath.StartsWith($releaseRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'ARCHIVE_PATH_DENIED'}
  if($file.sha256 -and (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'SOURCE_CHANGED_SINCE_AUDIT'}
  $entry=$archive.CreateEntry('gpt-dsh-monitor/'+$file.path,[IO.Compression.CompressionLevel]::Optimal)
  $input=[IO.File]::OpenRead($sourcePath);$output=$entry.Open();try{$input.CopyTo($output)}finally{$input.Dispose();$output.Dispose()}
 }
}finally{$archive.Dispose();$stream.Dispose()}
$hash=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($archivePath+'.sha256',$hash+'  '+[IO.Path]::GetFileName($archivePath)+[Environment]::NewLine)
[pscustomobject]@{ok=$true;entries=$manifest.files.Count+1;sha256=$hash} | ConvertTo-Json -Compress
