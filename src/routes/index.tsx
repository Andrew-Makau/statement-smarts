import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { parseMpesaPdf, type ParseResult, type MpesaTransaction } from "@/lib/mpesa-parser";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "M-Pesa Statement Parser" },
      { name: "description", content: "Parse M-Pesa PDF statements with full transaction capture" },
    ],
  }),
});

function fmt(n: number) {
  return n.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Index() {
  const [result, setResult] = useState<ParseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  async function onFile(file: File) {
    setLoading(true);
    setError(null);
    try {
      const r = await parseMpesaPdf(file);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const list: MpesaTransaction[] = showHidden
    ? (result?.hiddenTransactions ?? [])
    : (result?.transactions ?? []);

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <h1 className="text-3xl font-bold tracking-tight">M-Pesa Statement Parser</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Position-aware PDF parsing — captures every transaction. OD Loan Repayment &
            Overdraft entries are filtered out by default.
          </p>
        </header>

        <Card className="p-6">
          <label className="flex flex-col gap-3">
            <span className="text-sm font-medium">Upload M-Pesa PDF statement</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
              className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
            />
          </label>
          {loading && <p className="mt-3 text-sm text-muted-foreground">Parsing…</p>}
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </Card>

        {result && (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Card className="p-4">
                <div className="text-xs uppercase text-muted-foreground">Total parsed</div>
                <div className="mt-1 text-2xl font-semibold">{result.allCount}</div>
              </Card>
              <Card className="p-4">
                <div className="text-xs uppercase text-muted-foreground">Visible</div>
                <div className="mt-1 text-2xl font-semibold">{result.visibleCount}</div>
              </Card>
              <Card className="p-4">
                <div className="text-xs uppercase text-muted-foreground">Hidden (OD/Overdraft)</div>
                <div className="mt-1 text-2xl font-semibold">{result.hiddenCount}</div>
              </Card>
              <Card className="p-4">
                <div className="text-xs uppercase text-muted-foreground">Net (In − Out)</div>
                <div className="mt-1 text-2xl font-semibold">
                  {fmt(result.totals.paidIn - result.totals.withdrawn)}
                </div>
              </Card>
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant={showHidden ? "outline" : "default"}
                onClick={() => setShowHidden(false)}
              >
                Visible ({result.visibleCount})
              </Button>
              <Button
                variant={showHidden ? "default" : "outline"}
                onClick={() => setShowHidden(true)}
              >
                Hidden ({result.hiddenCount})
              </Button>
            </div>

            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Receipt</TableHead>
                    <TableHead>Date / Time</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>Dir</TableHead>
                    <TableHead className="text-right">Paid In</TableHead>
                    <TableHead className="text-right">Withdrawn</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((t, i) => (
                    <TableRow key={`${t.receiptNo}-${i}`}>
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      <TableCell className="font-mono text-xs">{t.receiptNo}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {t.completionTime}
                      </TableCell>
                      <TableCell className="max-w-md text-xs">{t.details}</TableCell>
                      <TableCell>
                        <Badge variant={t.direction === "credit" ? "default" : "secondary"}>
                          {t.direction}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {t.paidIn ? fmt(t.paidIn) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {t.withdrawn ? fmt(t.withdrawn) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {fmt(t.balance)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
