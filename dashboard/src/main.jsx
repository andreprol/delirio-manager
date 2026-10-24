import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { LiveSessionWindow } from './components/LiveSessionWindow'
import './styles.css'

const isLiveSessionWindow = window.electronAPI?.isLiveSessionWindow === true

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isLiveSessionWindow ? <LiveSessionWindow /> : <App />}
  </React.StrictMode>
)
