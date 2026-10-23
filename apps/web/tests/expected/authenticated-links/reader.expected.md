# Original

- heading "Travel policy" [level=2]
- button "Reload"
- button "View raw text"
- button "Quote selection" [disabled]
- heading "Travel expense policy" [level=1]
- table:
  - rowgroup:
    - row "Category Limit":
      - columnheader "Category"
      - columnheader "Limit"
  - rowgroup:
    - row "Train Standard fare":
      - cell "Train"
      - cell "Standard fare"
- blockquote:
  - paragraph: Employees must retain receipts.
- paragraph:
  - text: See
  - link "the original policy":
    - /url: https://gs.example.test/gsclaw/api/v1/zhidu/files/1234567890123456789
  - text: .
- text: <script>literal source</script>

# Incomplete

- heading "Travel policy" [level=2]
- button "Reload"
- status: The displayed content is incomplete
- button "View raw text"
- button "Quote selection" [disabled]
- heading "Travel expense policy" [level=1]
- table:
  - rowgroup:
    - row "Category Limit":
      - columnheader "Category"
      - columnheader "Limit"
  - rowgroup:
    - row "Train Standard fare":
      - cell "Train"
      - cell "Standard fare"
- blockquote:
  - paragraph: Employees must retain receipts.
- paragraph:
  - text: See
  - link "the original policy":
    - /url: https://gs.example.test/gsclaw/api/v1/zhidu/files/1234567890123456789
  - text: .
- text: <script>literal source</script>

# Source address mismatch

- heading "Source text" [level=2]
- button "Reload"
- alert: The source link does not match your signed-in service. Ask an administrator to update the policy links.

# Expired sign-in

- heading "Source text" [level=2]
- button "Reload"
- alert: Your sign-in expired. Sign in again and retry.
