"""From the repository root, run with Python and openpyxl 3.1.5 installed.

The XLSX crosses the process boundary as ZIP bytes. openpyxl resolves the
package itself, with formulas visible so accidental formula cells fail.
"""
from io import BytesIO
from subprocess import check_output

from openpyxl import load_workbook


def check_package():
    generate = """
        import { writeXlsx } from './src/xlsxpackage.ts';
        import { buildXlsxSheets } from './test/helpers/build-xlsx-sheets.ts';
        process.stdout.write(writeXlsx(buildXlsxSheets()));
    """
    data = check_output(["node", "--import", "tsx", "--input-type=module", "-e", generate])
    workbook = load_workbook(BytesIO(data), data_only=False)
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


if __name__ == "__main__":
    check_package()
    print("Verified both sheets, cell values and types, and the Z3:AB4 merge.")
