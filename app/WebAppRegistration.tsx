"use client";

import { useEffect } from "react";

export default function WebAppRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The site remains fully usable online if registration is blocked.
    });
  }, []);
  return null;
}
