param([Parameter(Mandatory=$true)][string]$ImagePath,[switch]$IncludeWords)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
function Await-OcrOperation($Operation, [Type]$ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(20000)) { throw 'Windows OCR operation timed out.' }
    return $task.Result
}
$stream = $null
$bitmap = $null
try {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { throw 'Windows OCR language support is unavailable on this PC.' }
    $file = Await-OcrOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($ImagePath))) ([Windows.Storage.StorageFile])
    $stream = Await-OcrOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-OcrOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-OcrOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-OcrOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($result.Lines | ForEach-Object { $_.Text })
    $output=@{ text = $result.Text; lines = $lines; engine = 'Windows.Media.Ocr' }
    if($IncludeWords) {
        $words=@()
        foreach($line in $result.Lines){foreach($word in $line.Words){
            $box=$word.BoundingRect
            $words+=@{text=$word.Text;x=$box.X/$bitmap.PixelWidth;y=($box.Y+$box.Height)/$bitmap.PixelHeight;w=$box.Width/$bitmap.PixelWidth;h=$box.Height/$bitmap.PixelHeight}
        }}
        $output.words=$words
    }
    $output | ConvertTo-Json -Depth 5 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
}
