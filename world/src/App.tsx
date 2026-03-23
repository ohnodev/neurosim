import { Navigate, Route, Routes } from 'react-router-dom'
import { OnchainProviders } from './components/OnchainProviders'
import FlyViewer from './components/FlyViewer'
import VisualizationPage from './pages/VisualizationPage'
import './App.css'

function App() {
  return (
    <OnchainProviders>
      <Routes>
        <Route path="/" element={<FlyViewer />} />
        <Route path="/visualization" element={<VisualizationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </OnchainProviders>
  )
}

export default App
