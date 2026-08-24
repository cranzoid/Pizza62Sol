import { TimeClockKiosk } from "@/app/staff/TimeClock";

export const metadata = { title: "Time clock kiosk", robots: { index: false, follow: false } };

export default function KioskPage() {
  return <TimeClockKiosk />;
}
