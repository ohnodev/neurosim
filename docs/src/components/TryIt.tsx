import { useRef, useState } from "react";

type TryItProps = {
  url: string;
};

export default function TryIt({ url }: TryItProps) {
  const [output, setOutput] = useState('Click "Try it" to fetch live JSON.');
  const [loading, setLoading] = useState(false);
  const requestCounter = useRef(0);

  async function run() {
    const currentId = ++requestCounter.current;
    setLoading(true);
    setOutput("Loading...");
    try {
      const response = await fetch(url);
      const text = await response.text();
      try {
        const parsed = JSON.parse(text);
        if (currentId === requestCounter.current) {
          setOutput(JSON.stringify(parsed, null, 2));
        }
      } catch {
        if (currentId === requestCounter.current) {
          setOutput(text);
        }
      }
    } catch (error) {
      if (currentId === requestCounter.current) {
        setOutput(
          `Live browser request failed. Try this command:\n\ncurl ${url}\n\nError: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
    } finally {
      if (currentId === requestCounter.current) {
        setLoading(false);
      }
    }
  }

  return (
    <>
      <button className="tryit-btn" onClick={run} disabled={loading}>
        {loading ? "Loading..." : "Try it"}
      </button>
      <pre className="tryit-output">{output}</pre>
    </>
  );
}
