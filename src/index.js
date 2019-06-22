import React from 'react'
import ReactDOM from 'react-dom'
import './assets/common.scss'
import './assets/reset.css'
import './config/rem'
import App from './page/App'
import * as serviceWorker from './serviceWorker'
import { createStore, applyMiddleware } from 'redux'
import createSagaMiddleware from 'redux-saga'
import { Provider } from 'react-redux'
import Reducers from './redux/reducers'
import rootSaga from './redux/sagas'

const LoadData = newVersion => {
  const easyMarket_version =
    JSON.parse(localStorage.getItem('easyMarket_version')) || ''
  let initData = undefined
  if (newVersion === easyMarket_version) {
    initData = JSON.parse(localStorage.getItem('easyMarket_initData'))
  } else {
    localStorage.setItem('easyMarket_version', newVersion)
  }
  return initData
}
const data = LoadData(3)
console.log(data)
const sagaMiddleware = createSagaMiddleware()

const store = createStore(Reducers, data, applyMiddleware(sagaMiddleware))

sagaMiddleware.run(rootSaga)

ReactDOM.render(
  <Provider store={store}>
    <App />
  </Provider>,
  document.getElementById('root')
)

window.onbeforeunload = () => {
  const state = store.getState()
  localStorage.setItem('easyMarket_initData', JSON.stringify(state))
}

serviceWorker.unregister()
