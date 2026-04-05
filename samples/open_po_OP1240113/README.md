# Test data for Open PO **OP1240113** (PFX OP1)

The scanned PDF could not be read as text in this environment, so quantities are **placeholders** (100 per line, **800** total). After you upload your real invoice, either:

- Edit **ASN `Invoice No.`** (production layout) to match the **invoice number** stored on that invoice (required for Open PO ASN check), and  
- Make **sum(GRN `GRN Qty.`)** = **sum(invoice line qty)** = **sum(DC `TRANSACTION QTY.`)** (all three must match for this PO while testing).

## Upload order (portal)

1. **Purchase orders** — include header **OP1240113** and all 8 lines (ITEM_ID / DESCRIPTION1 as in your master). Line `QTY` should be at least your billed qty (Open PO does not force invoice = PO line qty).
2. **GRN** — `OpenPO_Test_GRN_OP1240113.csv` (open in Excel → **Save As → .xlsx**).
3. **ASN** — `OpenPO_Test_ASN_OP1240113.csv` (same).
4. **Delivery challans (DC)** — `OpenPO_Test_DC_OP1240113.csv` (same).
5. **Invoice** — upload your PDF; the **invoice number** on the record must equal ASN **`Invoice No.`** — use **`UBSI-0943/25-26`** (from your attached Tax Invoice e-invoice). Line quantities must sum to the same total as GRN and DC (see sample **800** total, or change all three together to match the real bill, e.g. **2,436** KGS for the single RM00305 line on that invoice).

## Prefix

Ensure `open_po_prefixes` includes **OP1** (or **OP**) so this PO is treated as Open PO.

## Column headers (production templates)

The three CSVs use the **same column names and order** as your exports:

- **GRN** — `GRN details.xls` layout (**95** columns): e.g. `PO No.`, `PO Pfx.`, `PO Line`, `GRN No.`, `GRN Qty.`, `Description 1`, `Supplier`, `Supplier Name`, …
- **DC** — `DC transaction.xls` layout (**30** columns): `UNIT`, `ITEM`, `ITEM DESCRIPTION`, `DC NO.`, `ORDER NO.`, `TRANSACTION QTY.`, `GRN NO.`, …
- **ASN** — `ASN.xls` layout (**17** columns): `ANC No.`, `Supplier Code`, `Invoice No.`, `Invoice Date`, `DC No.`, …

Open in Excel and **Save As → .xlsx** before upload if the portal expects `.xlsx`. The importer also accepts aliases for older headers; see `backend/src/excelImport.js`.
