import { OnchainProviders } from './components/OnchainProviders'
import FlyViewer from './components/FlyViewer'
import './App.css'

function App() {
  return (
    <OnchainProviders>
      <FlyViewer />
    </OnchainProviders>
  )
}

export default App
