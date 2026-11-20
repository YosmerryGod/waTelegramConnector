import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// [ADDED] Use an isolated SQLite file because importing customer-service initializes its schema.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wagram-outlet-hours-"));
process.env.SQLITE_PATH = path.join(tempDir, "test.sqlite");
const database = await import("../../src/database.js");
const { getOutletOperatingStatus } = await import("../../src/ai/customer-service.js");

const outlet = {
  name: "Outlet Uji",
  timezone: "Asia/Jakarta",
  openTime: "08:00",
  closeTime: "21:00",
  openDays: ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
};

try {
  const open = getOutletOperatingStatus(
    outlet,
    new Date("2026-11-20T04:00:00.000Z") // Friday, 11:00 WIB
  );
  assert.equal(open.isOpen, true);
  assert.equal(open.localDay, "Friday");

  const justBeforeClose = getOutletOperatingStatus(
    outlet,
    new Date("2026-11-20T13:59:00.000Z") // Friday, 20:59 WIB
  );
  assert.equal(justBeforeClose.isOpen, true);
  const atClosingTime = getOutletOperatingStatus(
    outlet,
    new Date("2026-11-20T14:00:00.000Z") // Friday, 21:00 WIB
  );
  assert.equal(atClosingTime.isOpen, false);

  const closedWithNextOpening = getOutletOperatingStatus(
    outlet,
    new Date("2026-11-20T14:00:00.000Z") // Friday, 21:00 WIB
  );
  assert.equal(closedWithNextOpening.isOpen, false);
  assert.equal(closedWithNextOpening.nextOpeningAt, "2026-11-21T01:00:00.000Z");

  const weekdayOnly = {
    ...outlet,
    openTime: "09:00",
    closeTime: "17:00",
    openDays: ["Monday"]
  };
  const weekend = getOutletOperatingStatus(
    weekdayOnly,
    new Date("2026-11-21T04:00:00.000Z") // Saturday, 11:00 WIB
  );
  assert.equal(weekend.isOpen, false);
  assert.equal(weekend.nextOpeningAt, "2026-11-23T02:00:00.000Z"); // Monday at 09:00 WIB below

  const overnight = {
    ...outlet,
    openTime: "22:00",
    closeTime: "02:00",
    openDays: ["Friday"]
  };
  const afterMidnight = getOutletOperatingStatus(
    overnight,
    new Date("2026-11-20T19:00:00.000Z") // Saturday, 02:00 WIB
  );
  assert.equal(afterMidnight.isOpen, false, "The overnight interval closes exactly at 02:00.");
  const stillOpen = getOutletOperatingStatus(
    overnight,
    new Date("2026-11-20T18:30:00.000Z") // Saturday, 01:30 WIB
  );
  assert.equal(stillOpen.isOpen, true, "Friday's opening schedule must cover early Saturday.");

  const specialHoursOutlet = {
    ...outlet,
    specialHours: [{ date: "2026-11-20", openTime: "10:00", closeTime: "12:00" }]
  };
  const specialOpen = getOutletOperatingStatus(
    specialHoursOutlet,
    new Date("2026-11-20T04:00:00.000Z") // Friday, 11:00 WIB
  );
  assert.equal(specialOpen.isOpen, true);
  const specialClosed = getOutletOperatingStatus(
    specialHoursOutlet,
    new Date("2026-11-20T06:00:00.000Z") // Friday, 13:00 WIB
  );
  assert.equal(specialClosed.isOpen, false);

  const holidayOutlet = {
    ...outlet,
    specialHours: [{ date: "2026-11-20", closed: true }]
  };
  const holiday = getOutletOperatingStatus(
    holidayOutlet,
    new Date("2026-11-20T04:00:00.000Z")
  );
  assert.equal(holiday.isOpen, false);
  assert.equal(holiday.reason, "special_closure");
  assert.equal(holiday.nextOpeningAt, "2026-11-21T01:00:00.000Z");

  const specialOverridesClosedWeekday = {
    ...outlet,
    openDays: ["Monday"],
    specialHours: [{ date: "2026-11-21", openTime: "10:00", closeTime: "14:00" }]
  };
  const specialSaturday = getOutletOperatingStatus(
    specialOverridesClosedWeekday,
    new Date("2026-11-21T04:00:00.000Z") // Saturday, 11:00 WIB
  );
  assert.equal(specialSaturday.isOpen, true, "Date-specific opening hours override the weekly closed day.");

  const invalidHours = getOutletOperatingStatus(
    { ...outlet, openTime: "25:00" },
    new Date("2026-11-20T04:00:00.000Z")
  );
  assert.equal(invalidHours.isOpen, null);
  assert.equal(invalidHours.reason, "hours_not_configured");

  console.log("PASS: outlet timezone, weekdays, next opening, overnight boundary, and invalid-hour handling.");
} finally {
  database.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
