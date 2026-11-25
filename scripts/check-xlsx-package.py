"""From the repository root, run with Python and openpyxl 3.1.5 installed.

The XLSX crosses the process boundary as ZIP bytes. openpyxl resolves the
package itself, with formulas visible so accidental formula cells fail.
"""
from io import BytesIO
from subprocess import check_output

from openpyxl import load_workbook


def read_generated(generate):
    data = check_output(["node", "--import", "tsx", "--input-type=module", "-e", generate])
    return load_workbook(BytesIO(data), data_only=False)


def check_package():
    generate = """
        import { writeXlsx } from './src/xlsxpackage.ts';
        import { buildXlsxSheets } from './test/helpers/build-xlsx-sheets.ts';
        process.stdout.write(writeXlsx(buildXlsxSheets()));
    """
    workbook = read_generated(generate)
    assert workbook.sheetnames == ['Sales & "tax"', '第二']
    sheet = workbook.worksheets[0]
    expected = {
        "A1": ("00123", "s"), "B1": ("=1+2", "s"), "C1": (12.5, "n"),
        "D1": (True, "b"), "E1": (False, "b"), "F1": (None, "n"),
        "G1": (" <A&B> 🐝 ", "s"), "H1": ("", "s"), "Z3": ("Across Z", "s"),
    }
    for address, pair in expected.items():
        cell = sheet[address]
        assert (cell.value, cell.data_type) == pair, (address, cell.value, cell.data_type)
    assert {str(r) for r in sheet.merged_cells.ranges} == {"Z3:AB4"}
    assert list(workbook.worksheets[1].values) == [(0, -7)]
    workbook.close()


def check_pdf_tables():
    workbook = read_generated("""
        import { Document } from './src/index.ts';
        import { buildXlsxTablePdf } from './test/helpers/build-xlsx-table-pdf.ts';
        process.stdout.write(Document.Open(buildXlsxTablePdf()).ToXlsx());
    """)
    assert workbook.sheetnames == ["T1"]
    sheet = workbook.active
    assert list(sheet.values) == [("Register", None), ("00123", "=1+2"), ("00456", "Final")]
    assert sheet["B2"].data_type == "s"
    assert {str(r) for r in sheet.merged_cells.ranges} == {"A1:B1"}
    workbook.close()

    workbook = read_generated("""
        import { Document } from './src/index.ts';
        import { buildNestedTablePdf } from './test/helpers/build-nested-table-pdf.ts';
        process.stdout.write(await Document.Open(buildNestedTablePdf()).ToXlsxAsync());
    """)
    assert workbook.sheetnames == ["T1", "T2 (T1!B2)", "T3 (T2!A2)"]
    assert [sheet["A1"].value for sheet in workbook] == ["A", "D", "G"]
    workbook.close()


if __name__ == "__main__":
    check_package()
    check_pdf_tables()
    print("Verified the package writer, stitched PDF table, and nested PDF worksheets.")
