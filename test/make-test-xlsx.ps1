# Writes test\book.xlsx: a small two-sheet Excel workbook (text, numbers, a date, TRUE/FALSE, a formula's saved
# value and a "<script>" text cell) for Test-Viewer.cmd. Built from its XML parts with .NET's ZIP writer, so the
# viewer's own unpacking (deflate) is tested. Run again to recreate it.
# Only Windows PowerShell's own modules (set before any command is used).
$env:PSModulePath = $PSHOME + '\Modules'
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$out = Join-Path $PSScriptRoot 'book.xlsx'
$parts = [ordered]@{
    '[Content_Types].xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
    '_rels/.rels' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    'xl/workbook.xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>'
    'xl/_rels/workbook.xml.rels' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    'xl/sharedStrings.xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="10" uniqueCount="10"><si><t>Item</t></si><si><t>Amount</t></si><si><t>Date</t></si><si><t>Paid</t></si><si><t>Note</t></si><si><t>Pens</t></si><si><t>Paper</t></si><si><t>&lt;script&gt;window.PWN=''xlsx''&lt;/script&gt;</t></si><si><r><t>Rich </t></r><r><t>text</t></r></si><si><t>Total</t></si></sst>'
    'xl/styles.xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>'
    'xl/worksheets/sheet1.xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row><row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2"><v>12.5</v></c><c r="C2" s="1"><v>46302</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="s"><v>7</v></c></row><row r="3"><c r="A3" t="s"><v>6</v></c><c r="B3"><v>3</v></c><c r="C3" s="2"><v>46303</v></c><c r="D3" t="b"><v>0</v></c><c r="E3" t="inlineStr"><is><t>inline text</t></is></c></row><row r="4"><c r="A4" t="s"><v>9</v></c><c r="B4"><f>SUM(B2:B3)</f><v>15.5</v></c><c r="E4" t="s"><v>8</v></c></row></sheetData></worksheet>'
    'xl/worksheets/sheet2.xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Remark</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>second sheet</t></is></c></row></sheetData></worksheet>'
}
if (Test-Path -LiteralPath $out) { [IO.File]::Delete($out) }
$fs = [IO.File]::Open($out, 'CreateNew')
try {
    $zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
    foreach ($name in $parts.Keys) {
        $e = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
        $w = New-Object IO.StreamWriter($e.Open(), (New-Object Text.UTF8Encoding $false))
        $w.Write($parts[$name]); $w.Dispose()
    }
    $zip.Dispose()
} finally { $fs.Dispose() }
"Wrote $out ($((Get-Item $out).Length) bytes)."
