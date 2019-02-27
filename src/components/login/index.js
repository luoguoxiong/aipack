import React, {Component} from 'react'
import './index.scss'
import { Button, Toast } from 'antd-mobile'
import http from '../../http'
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as CommonAction from '../../redux/actions/common';
class Login extends Component{
  async submitLogin () {
    const mobile = this.refs.phoneNumber.value
    const password = this.refs.passwords.value
    const {errno, data, errmsg} = await  http.postLogin({mobile, password})
    if(errno === 0){
      window.localStorage.setItem('token', data.sessionKey)
      window.localStorage.setItem('nideShopUser', data.mobile)
      this.props.actions.loginSuccess()
    } else {
      Toast.fail(errmsg, .5)
    }
  }
  render () {
    return (
      <div className="loginBox">
        <div className="logo">
          <img src="http://yanxuan.nosdn.127.net/bd139d2c42205f749cd4ab78fa3d6c60.png" alt=""/>
        </div>
        <div className="loginMain">
          <div className="inputWrap onePx_bottom">
            <input type="text" ref="phoneNumber" value={15323807318} placeholder="请输入手机号码" />
          </div>
          <div className="inputWrap onePx_bottom">
            <input type="password" ref="passwords" value={123456} placeholder="请输入登录密码" />
          </div>
          <div className="loginBtn">
            <Button type="primary" onClick={this.submitLogin.bind(this)}>登录</Button>
          </div>
        </div>
      </div>
    )
  }
}
const mapDispatchToProps = dispatch => ({actions: bindActionCreators(CommonAction, dispatch)})
export default (connect(null, mapDispatchToProps)(Login))