import React from 'react';
import './app.css';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Provider } from 'react-redux';
import { routes } from '@/src/router';
import { store } from '@/src/models/store';
const router = createBrowserRouter(routes);
function App() {
  return (
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  );
}

export default App;
