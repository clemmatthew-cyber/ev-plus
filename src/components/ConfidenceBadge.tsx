export default function ConfidenceBadge({ grade }: { grade: "A" | "B" | "C" | "D" }) {
  const blocks = grade === "A" ? 4 : grade === "B" ? 3 : grade === "C" ? 2 : 1;
  const color = grade === "A" ? "bg-emerald-500" : grade === "B" ? "bg-emerald-500/70" : grade === "C" ? "bg-amber-500/70" : "bg-zinc-500/50";
  return (
    <div className="flex items-center gap-0.5">
      {[1,2,3,4].map(i => (
        <div key={i} className={`w-1.5 h-3 rounded-[1px] ${i <= blocks ? color : "bg-zinc-800"}`} />
      ))}
    </div>
  );
}
