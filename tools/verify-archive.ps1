param([Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
$stream=[IO.File]::OpenRead([IO.Path]::GetFullPath($Archive))
$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read)
try{
 $entry=$zip.GetEntry('gpt-dsh-monitor/FILE-MANIFEST.json');if(-not $entry){throw 'ARCHIVE_MANIFEST_MISSING'}
 $reader=[IO.StreamReader]::new($entry.Open());try{$manifest=$reader.ReadToEnd() | ConvertFrom-Json}finally{$reader.Dispose()}
 if(-not $manifest.audit.ok -or $zip.Entries.Count -ne $manifest.files.Count+1){throw 'ARCHIVE_INVENTORY_INVALID'}
 $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($item in $zip.Entries){if(-not $names.Add($item.FullName) -or $item.FullName -match '(^|/)\.\.(/|$)|\\|^[^/]+:/'){throw 'ARCHIVE_PATH_INVALID'}}
 foreach($file in $manifest.files){$item=$zip.GetEntry('gpt-dsh-monitor/'+$file.path);if(-not $item -or $item.Length -ne $file.bytes){throw 'ARCHIVE_FILE_MISSING'};$input=$item.Open();$hash=[Security.Cryptography.SHA256]::Create();try{$actual=[Convert]::ToHexString($hash.ComputeHash($input)).ToLowerInvariant();if($actual -ne $file.sha256){throw 'ARCHIVE_HASH_MISMATCH'}}finally{$hash.Dispose();$input.Dispose()}}
 [pscustomobject]@{ok=$true;entries=$zip.Entries.Count;filesVerified=$manifest.files.Count} | ConvertTo-Json -Compress
}finally{$zip.Dispose();$stream.Dispose()}
