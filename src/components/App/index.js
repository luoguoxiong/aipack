import React, { Component, Fragment } from 'react';
import  { Router, Route, Redirect} from 'react-router-dom'
import Tab from '../tab'
import history from '../../config/history';
import routes from '../../routers'
import { ActivityIndicator } from 'antd-mobile';
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as CommonAction from '../../redux/actions/common';
import Login from '../login'
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
          <div className={item.isTab?'tabPageContent':'isLogin' in item? 'login' :'noTabPageContent'}>
            <item.component />
          </div>
        )} />
    )
  })
}


class App extends Component {
  componentDidMount() {
    // setTimeout(() => {
    //   this.props.actions.loginFailure()
    // },2000)
  }
  render() {
    const {isloading, isLogin} = this.props
    return (
      <div className="App">
        <ActivityIndicator
          toast
          text="loading..."
          animating={isloading}
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
    isloading: state.common.isloading,
    isLogin: state.common.isLogin
  })

const mapDispatchToProps = dispatch => ({
    actions: bindActionCreators(CommonAction, dispatch)
  })

export default (connect(mapStateToProps, mapDispatchToProps)(App));