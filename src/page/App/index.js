import React, { Component, Fragment } from 'react';
import  { Router, Route, Redirect} from 'react-router-dom'
import Tab from '../../components/tab'
import history from '../../config/history';
import routes from '../../router'
import { ActivityIndicator } from 'antd-mobile';
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as CommonAction from '../../redux/actions/common';
import Login from '../../page/login'
const tabList = [
  {icon:'iconfont icon-caidaniconshouyehui',name: '首页',url:'/home'},
  {icon:'iconfont icon-clone',name: '专题',url:'/topic'},
  {icon:'iconfont icon-sort',name: '分类',url:'/catelog'},
  {icon:'iconfont icon-cart',name: '购物车', url:'/cart'},
  {icon:'iconfont icon-mine',name: '我的',url:'/mine'}
  ]
function RenderRouters({routes}) {
  return routes.map((item) =>{
    return(
      <Route
        path={item.link}
        key={item.name}
        render={() => (
          <div className={item.isTab?'tabPageContent':'noTabPageContent'}>
            <item.component />
          </div>
        )} />
    )
  })
}
class App extends Component {
  render() {
    const {isLoading, isLogin} = this.props
    return (
      <div className="App">
        <ActivityIndicator
          toast
          text="loading..."
          animating={isLoading}
        />
        {
          isLogin?
            <Router history={history}>
              <Fragment>
                <Route exact path="/" render={() => (
                  <Redirect to="/home" />
                )} />
                <RenderRouters routes={routes}></RenderRouters>
                <Tab tabList={tabList}></Tab>
              </Fragment>
            </Router>:
            <Login></Login>
        }
      </div>
    );
  }
}
const mapStateToProps = (state, props) => ({
    isLoading: state.common.isloading,
    isLogin: state.common.isLogin
  })

const mapDispatchToProps = dispatch => ({
    actions: bindActionCreators(CommonAction, dispatch)
  })

export default (connect(mapStateToProps, mapDispatchToProps)(App));
