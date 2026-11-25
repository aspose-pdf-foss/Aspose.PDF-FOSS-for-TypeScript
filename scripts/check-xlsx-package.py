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


def check_go_fixtures():
    # xlsx_write_test.go at dfa75dbfb300e6eb5a8e5d2199f81d07ed602916.
    # The TypeScript policy keeps source text literal in both modes.
    workbook = read_generated("""
        import { buildXlsxGoTable } from './test/helpers/build-xlsx-page-pdf.ts';
        process.stdout.write(buildXlsxGoTable().ToXlsx());
    """)
    table = workbook.active
    assert list(table.values) == [("Item", "Qty", "Price"), ("Apples", "3", "€4.50"),
                                  ("Pears", "2", "€5.25"), ("Total", None, "€9.75")]
    assert {str(r) for r in table.merged_cells.ranges} == {"A4:B4"}
    workbook.close()

    workbook = read_generated("""
        import { buildXlsxPageDoc } from './test/helpers/build-xlsx-page-pdf.ts';
        process.stdout.write(await buildXlsxPageDoc().ToXlsxAsync({mode: 'pages'}));
    """)
    assert workbook.sheetnames == ["Page 1", "Page 2"]
    sheet = workbook.worksheets[0]
    rows = [[cell for cell in row if cell.value is not None] for row in sheet]
    title, amounts = [row for row in rows if row]
    assert [cell.value for cell in title + amounts] == ["Report Title", "Revenue", "1200"]
    assert amounts[1].data_type == "s" and amounts[1].column > amounts[0].column
    assert amounts[0].column == title[0].column
    assert [cell.value for row in workbook.worksheets[1] for cell in row if cell.value] == ["Second page"]
    assert sheet.column_dimensions["A"].width > 0 and sheet.row_dimensions[1].height > 0
    for page in workbook:
        pic, = page._images
        assert (pic.width, pic.height) == (2, 1)
        assert (pic.anchor.pos.x, pic.anchor.pos.y) == (762000, 2844800)
        assert (pic.anchor.ext.cx, pic.anchor.ext.cy) == (457200, 228600)
    workbook.close()


if __name__ == "__main__":
    check_package()
    check_pdf_tables()
    check_go_fixtures()
    print("Verified XLSX packaging, table and page layouts, literal values, and picture anchors.")
