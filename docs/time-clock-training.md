# Pizza 62 time-clock training

This guide covers the employee **My Clock** screen, the shared-tablet kiosk, and the manager **Time Clock** workspace. The clock records exact Toronto timestamps. It does not round punches automatically, and unpaid breaks are removed from paid hours.

## The correct punch sequence

Every shift must follow this sequence:

1. **Clock in** when work starts.
2. **Start break** when an unpaid break starts.
3. **End break** when work resumes.
4. Repeat steps 2–3 if another unpaid break is taken.
5. **Clock out** when work ends.

Do not clock in twice or clock out twice. The application now blocks an invalid next step and asks a manager to review any damaged legacy history.

## Employee training: My Clock

### Start a shift

1. Open `/employee` and sign in with your own staff account.
2. Choose **Clock** in the left navigation.
3. Confirm your name and the status **You are off shift**.
4. Select the large **Clock in** button once.
5. Wait for the confirmation **You are clocked in**. The status changes to **You are on shift** and the paid-shift timer begins.

### Take an unpaid break

1. Before leaving work, open **Clock**.
2. Select **Start break** once.
3. Wait for the confirmation. The status changes to **You are on an unpaid break** and paid time pauses.
4. When returning, select **End break** once.
5. Wait for **You are back on shift** before resuming work.

### End a shift

1. Finish all work duties.
2. If the screen says **On break**, select **End break** first.
3. Select **Clock out** once.
4. Wait for **You are clocked out** and confirm the status says **You are off shift**.
5. Check **Recent activity** for the clock-out timestamp.

### Review hours and schedule

1. Choose **My schedule** to see published shifts. Draft shifts are not shown to employees.
2. Choose **My hours** to see clock-in, clock-out, unpaid break, and paid totals by day.
3. Use **Earlier** and **Later** to move between pay periods.
4. Overtime appears after the employee's configured weekly threshold (44 hours by default).

### Ask to correct a punch

Employees must not invent a second punch to correct a mistake.

1. Choose **Requests** and open **Fix a punch**.
2. Select the incorrect punch.
3. Enter the correct date and time.
4. Explain what happened in plain language.
5. Select **Send to your manager**.
6. Continue using the current status shown on the Clock screen. If the clock is paused for review, contact a manager before trying another punch.

## Employee training: shared kiosk

1. Open `/kiosk` on the paired store tablet.
2. Tap your own name.
3. Enter your personal 4–8 digit PIN. Never use or share another employee's PIN.
4. Choose the correct action: **Clock in**, **Start break**, **End break**, or **Clock out**.
5. Read the confirmation containing your name, new status, and time.
6. Make sure the kiosk returns to the name list before walking away.

If the tablet says it is not paired, do not use another employee's account. Ask the owner to pair the device again.

## Manager training: initial setup

### Give an employee access and a PIN

1. In the admin portal, open **Team**.
2. Create or open the employee's staff account and confirm it is active.
3. Give managers only the permissions required for their job. Time-record editing, correction approval, employee management, and payroll export are separate permissions.
4. Open **Time Clock → Pay & PINs**.
5. Open the employee, enter their job title, hourly wage, employment type, and weekly overtime threshold, then save.
6. Enter a unique 4–8 digit clock-in PIN and select **Set PIN**. The PIN itself is never displayed again or written to the audit log.

### Pair the shared kiosk

1. In **Admin → Team**, find **Shared time-clock tablet**.
2. Select **Generate pairing link**.
3. Open that link once on the physical store tablet.
4. Confirm the employee name list appears.
5. Generating another link invalidates the previous tablet token, so do this again only when replacing or re-pairing the device.

## Manager training: daily operation

1. Open **Time Clock → Team clock** at the start of the day.
2. Review every active employee card, not only people currently working.
3. A green **Working**, amber **On break**, or grey **Off shift** badge shows the verified state.
4. Use **Clock in for them**, **Start break**, **End break**, or **Clock out** only when the manager is acting for that employee in real time.
5. Read the latest-punch timestamp before taking an action.
6. If a card says **Needs review**, do not add another live punch. Open the employee under **Timesheets** and repair the history first.

## Manager training: repair and approve a timesheet

1. Open **Time Clock → Timesheets**.
2. Choose the correct pay period with **Earlier** or **Later**.
3. Open the employee's timesheet.
4. Review each day's In, Out, Break, and Paid totals.
5. Review **Punch history**. The source identifies Employee clock, Shared kiosk, or Manager entry.
6. To correct a timestamp, change the date/time on that row and select **Save time**.
7. To remove a genuinely incorrect punch, select **Delete**, read the confirmation carefully, and confirm. Deletion is allowed only if the remaining sequence is valid.
8. To add a missing punch, select the punch type and exact local time under **Add a missing punch**, then select **Add punch**. The application rejects duplicates, future punches, and invalid sequence changes.
9. Confirm the employee no longer shows **Needs repair** and has no open shift.
10. Select **Approve timesheet** only after every day is reviewed. A later punch change automatically marks the approval **Needs review** so stale payroll cannot be exported as approved.

All manager punch additions, timestamp changes, deletions, and approvals are written to the audit log with the manager's identity.

## Manager training: requests, schedule, and payroll

### Correction requests

1. Open **Requests**.
2. Compare the original timestamp, requested timestamp, reason, schedule, and surrounding punches.
3. Select **Approve & move the punch** only when the corrected sequence is valid, or **Decline** when it is not supported.
4. Re-open the employee's timesheet and approve it again if the changed punch belongs to an approved period.

### Schedule

1. Open **Schedule** and choose the week.
2. Select a day cell to add a shift, or select an existing shift to edit it.
3. Assign the employee, role, start/end, planned unpaid break, and notes.
4. Save the shift as a draft. Overlapping shifts for one employee are blocked.
5. Review the full week and select **Publish**. Employees see only published shifts.

### Payroll

1. Resolve every **Needs review** record and close every open shift.
2. Open each timesheet, review it, and select **Approve timesheet**.
3. Open **Pay & PINs** and confirm wage and overtime settings.
4. Select **Export payroll CSV**.
5. If export is blocked, follow the named employee back to **Timesheets** and repair their punch history. Do not calculate around the warning manually.

## End-of-day manager checklist

1. Confirm no employee who has left still shows **Working** or **On break**.
2. Review pending correction and time-off requests.
3. Check for **Needs review** cards.
4. Confirm tomorrow's schedule is published.
5. At pay-period close, approve every clean timesheet before exporting payroll.

## Rahul reset

Rahul's incorrect punch events and stale live-clock state were removed. His employee account, active status, PIN, permissions, scheduled shifts, and historical audit evidence were preserved. He should use **Clock in** once at the beginning of his next real shift; no replacement punch has been added in advance.
