import React from 'react';
import ReactDOM from 'react-dom';
import './assets/common.scss';
import './assets/reset.css';
import './config/rem'
import App from './page/App';
import * as serviceWorker from './serviceWorker';
import { createStore, applyMiddleware } from 'redux';
import createSagaMiddleware from 'redux-saga'
import { Provider } from 'react-redux';
import Reducers from './redux/reducers';
import rootSaga from './redux/sagas';
const sagaMiddleware = createSagaMiddleware();
const store = createStore(Reducers, applyMiddleware(sagaMiddleware));
sagaMiddleware.run(rootSaga)
ReactDOM.render(
  <Provider store={store}>
    <App />
  </Provider>
  , document.getElementById('root'));
serviceWorker.unregister();
