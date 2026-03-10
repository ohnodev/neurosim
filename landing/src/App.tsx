import { useState, useEffect } from 'react';
import { OnchainProviders } from './components/OnchainProviders';
import { BrainPlot } from './components/BrainPlot';
import { ClaimFlySection } from './components/ClaimFlySection';
import { ConnectButton } from './components/ConnectButton';
import { getApiBase } from './lib/constants';
import './App.css';

const LORE_ARTICLE = 'https://theinnermostloop.substack.com/p/the-first-multi-behavior-brain-upload';
const X_PLACEHOLDER = 'https://x.com/neurosim';
const TG_PLACEHOLDER = 'https://t.me/neurosim';

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function App() {
  const [caCopied, setCaCopied] = useState(false);
  const [neuroTokenAddress, setNeuroTokenAddress] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${getApiBase()}/api/claim/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { neuroTokenAddress?: string } | null) => {
        const addr = d?.neuroTokenAddress;
        if (addr && addr !== '0x0000000000000000000000000000000000000000') {
          setNeuroTokenAddress(addr);
        }
      })
      .catch(() => {});
  }, []);

  const handleCopyCA = async () => {
    if (!neuroTokenAddress) return;
    try {
      await navigator.clipboard.writeText(neuroTokenAddress);
      setCaCopied(true);
      setTimeout(() => setCaCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  return (
    <OnchainProviders>
      <div className="app">
        <div className="bg" aria-hidden />
        <header className="header">
          <span className="header__ticker">$NEURO</span>
          <div className="header__actions">
            <ConnectButton />
          </div>
        </header>

        <div className="dashboard">
          <section className="dashboard__hero">
            <div className="hero__brain">
              <BrainPlot />
            </div>
            <div className="hero__text">
              <h1 className="hero__title">NeuroSim</h1>
              <p className="hero__tagline">Claim your digital fly. One brain, infinite simulations.</p>
            </div>
          </section>

          <aside className="dashboard__sidebar">
            <div className="card card--intro">
              <h2 className="card__title">About</h2>
              <p className="card__text">
                Token launched on <strong>The Cabal</strong>. Heard about the first multi-behavior brain upload, went down the rabbit hole, got the dataset, added the interface, wrapped crypto around it, and shipped it — Cabal style.
              </p>
            </div>

            <div className="card card--links">
              <h2 className="card__title">Links</h2>
              <a href="https://docs.neurosim.fun" target="_blank" rel="noopener noreferrer" className="card__link">
                Docs
              </a>
              <a href={LORE_ARTICLE} target="_blank" rel="noopener noreferrer" className="card__link">
                Lore · First Multi-Behavior Brain Upload
              </a>
              <a href="https://world.neurosim.fun" target="_blank" rel="noopener noreferrer" className="card__link">
                Enter World
              </a>
            </div>

            <div className="card card--socials">
              <h2 className="card__title">Socials</h2>
              <div className="socials">
                <a href={X_PLACEHOLDER} target="_blank" rel="noopener noreferrer" className="card__link">
                  X
                </a>
                <a href={TG_PLACEHOLDER} target="_blank" rel="noopener noreferrer" className="card__link">
                  Telegram
                </a>
              </div>
            </div>

            {neuroTokenAddress && (
              <div className="card card--ca">
                <h2 className="card__title">Contract</h2>
                <button
                  type="button"
                  className="ca-copy"
                  onClick={handleCopyCA}
                  aria-label="Copy contract address"
                >
                  <code className="ca-copy__value">{formatAddress(neuroTokenAddress)}</code>
                  <span className="ca-copy__icon">{caCopied ? <CheckIcon /> : <CopyIcon />}</span>
                </button>
              </div>
            )}

            <div className="card card--claim">
              <ClaimFlySection />
            </div>
          </aside>
        </div>

        <footer className="footer">
          <div className="footer__brand">
            <a
              href="https://thecabal.app"
              target="_blank"
              rel="noopener noreferrer"
              className="footer__cabal-link"
              title="The Cabal"
            >
              <img
                src="/cabal-king-512-opt.jpg"
                alt="The Cabal"
                className="footer__cabal-logo"
              />
            </a>
            <div className="footer__text">
              <span className="footer__copy">NeuroSim — $NEURO. Launched on the Cabal.</span>
              <span className="footer__obelisk">
                Powered by{' '}
                <a href="https://theobelisk.ai" target="_blank" rel="noopener noreferrer">
                  theobelisk.ai
                </a>
                — part of The Obelisk initiative into AI consciousness.
              </span>
            </div>
          </div>
        </footer>
      </div>
    </OnchainProviders>
  );
}

export default App;
