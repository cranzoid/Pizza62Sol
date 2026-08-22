import { UtilityHeader } from "@/app/UtilityHeader";

export default function PolicyPage({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro: string; children: React.ReactNode }) {
  return <div className="utility-page"><a className="skip-link" href="#utility-content">Skip to content</a><UtilityHeader /><main className="utility-content" id="utility-content"><div className="utility-title"><p className="eyebrow dark" style={{ justifyContent: "center" }}><span /> {eyebrow}</p><h1>{title}</h1><p>{intro}</p></div><article className="feedback-card policy-card">{children}</article></main></div>;
}
