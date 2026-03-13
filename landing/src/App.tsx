import { useState, useCallback, memo } from 'react';
import { OnchainProviders } from './components/OnchainProviders';
import { BrainPlot } from './components/BrainPlot';
import { MyNeuroFlies } from './components/MyNeuroFlies';
import { ConnectButton } from './components/ConnectButton';
import { CopyIcon, CheckIcon, DocsIcon, ArticleIcon, WorldIcon } from './components/Icons';
import './App.css';

const LORE_ARTICLE = 'https://theinnermostloop.substack.com/p/the-first-multi-behavior-brain-upload';
const X_URL = 'https://x.com/i/communities/2031850986466078872';
const TG_URL = 'https://t.me/neurosimportal';
const YOUTUBE_VIDEO_URL = 'https://www.youtube.com/watch?v=tV874dr02yQ';
const YOUTUBE_EMBED_ID = 'tV874dr02yQ';

/** Token address - single config to update later. */
const TOKEN_ADDRESS = '0x73e0591f7b75cc4D82B415d34Cd353683C896cbf';

function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

type TabId = 'connectome' | 'video';

const DashboardSidebar = memo(function DashboardSidebar({
  onCopyCA,
  caCopied,
}: {
  onCopyCA: () => void;
  caCopied: boolean;
}) {
  return (
    <aside className="dashboard__sidebar">
      <div className="card card--intro">
        <h2 className="card__title">About</h2>
        <p className="card__text">
          Token launched on{' '}
          <a href={`https://thecabal.app/base/${TOKEN_ADDRESS}`} target="_blank" rel="noopener noreferrer" className="card__link-inline">The Cabal</a>
          . Heard about the first multi-behavior brain upload, went down the rabbit hole, got the dataset, added the interface, wrapped crypto around it, and shipped it — Cabal style.
        </p>
      </div>

      <div className="card card--links">
        <h2 className="card__title">Links</h2>
        <a href="https://docs.neurosim.fun" target="_blank" rel="noopener noreferrer" className="card__link-btn">
          {DocsIcon}
          <span>Docs</span>
        </a>
        <a href={LORE_ARTICLE} target="_blank" rel="noopener noreferrer" className="card__link-btn">
          {ArticleIcon}
          <span>Lore · First Multi-Behavior Brain Upload</span>
        </a>
        <a href="https://world.neurosim.fun" target="_blank" rel="noopener noreferrer" className="card__link-btn">
          {WorldIcon}
          <span>Enter World</span>
        </a>
      </div>

      <div className="card card--socials">
        <h2 className="card__title">Socials</h2>
        <div className="socials">
          <a href={X_URL} target="_blank" rel="noopener noreferrer" className="card__link">
            X
          </a>
          <a href={TG_URL} target="_blank" rel="noopener noreferrer" className="card__link">
            Telegram
          </a>
        </div>
        <div className="socials__ca">
          <button
            type="button"
            className="ca-copy"
            onClick={onCopyCA}
            aria-label="Copy contract address"
          >
            <code className="ca-copy__value">{formatAddress(TOKEN_ADDRESS)}</code>
            <span className="ca-copy__icon">{caCopied ? CheckIcon : CopyIcon}</span>
          </button>
          <a
            href={`https://basescan.org/address/${TOKEN_ADDRESS}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ca-basescan"
            title="View on BaseScan"
            aria-label="View contract on BaseScan"
          >
            <img src="/basescan-logo.svg" alt="" width={20} height={20} />
          </a>
        </div>
      </div>
    </aside>
  );
});

function App() {
  const [caCopied, setCaCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('connectome');

  const handleCopyCA = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(TOKEN_ADDRESS);
      setCaCopied(true);
      setTimeout(() => setCaCopied(false), 1800);
    } catch {
      /* ignore */
    }
  }, []);

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

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            id="tab-connectome"
            aria-selected={activeTab === 'connectome'}
            aria-controls="panel-connectome"
            className={`tabs__btn ${activeTab === 'connectome' ? 'tabs__btn--active' : ''}`}
            onClick={() => setActiveTab('connectome')}
          >
            Connectome
          </button>
          <button
            type="button"
            role="tab"
            id="tab-video"
            aria-selected={activeTab === 'video'}
            aria-controls="panel-video"
            className={`tabs__btn ${activeTab === 'video' ? 'tabs__btn--active' : ''}`}
            onClick={() => setActiveTab('video')}
          >
            Video
          </button>
        </div>

        <div className="dashboard">
          {activeTab === 'connectome' && (
            <div id="panel-connectome" role="tabpanel" aria-labelledby="tab-connectome" className="dashboard__connectome-panel">
          <section className="dashboard__hero">
            <div className="hero__brain">
              <BrainPlot />
            </div>
            <div className="hero__neuroflies">
              <MyNeuroFlies />
            </div>
            <div className="hero__text">
              <h1 className="hero__title">NeuroSim</h1>
              <p className="hero__tagline">
                Release NeuroFlies into the simulation to compete for resources and earn tokens. We load real fruit fly neurons and connections, feed them sensory data, and execute actions from the model — navigating your fly in the world.
              </p>
            </div>
          </section>

          <DashboardSidebar onCopyCA={handleCopyCA} caCopied={caCopied} />
            </div>
          )}

          {activeTab === 'video' && (
            <section id="panel-video" role="tabpanel" aria-labelledby="tab-video" className="youtube-section youtube-section--full">
              <div className="youtube-section-inner">
                <h2 className="youtube-section-title">See NeuroSim in action</h2>
                <p className="youtube-section-desc">
                  Watch how we load fruit fly neurons, feed them sensory data, and run the simulation.
                </p>
                <div className="youtube-embed-wrap">
                  <iframe
                    src={`https://www.youtube.com/embed/${YOUTUBE_EMBED_ID}`}
                    title="NeuroSim project overview"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    className="youtube-embed"
                  />
                </div>
                <a
                  href={YOUTUBE_VIDEO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="youtube-watch-link"
                >
                  Watch on YouTube
                </a>
              </div>
            </section>
          )}
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
