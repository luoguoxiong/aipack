import React, {Component} from 'react'
import {Toast} from 'antd-mobile'
import './index.scss'
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as commonAction from '../../redux/actions/common';
import {withRouter} from "react-router-dom";
class Mine extends Component{
  state = {
    userPower: [
      {
        icon: 'icon-shoucang',
        name: '我的收藏',
        link: '/collect'
      },
      {
        icon: 'icon-iconfontdizhi',
        name: '地址管理',
        link: '/address'
      },
      {
        icon: 'icon-order',
        name: '我的订单'
      },
      {
        icon: 'icon-rili',
        name: '周末拼单'
      },
      {
        icon: 'icon-youhuiquan',
        name: '优惠券'
      },
      {
        icon: 'icon-youxuan',
        name: '优选购'
      },
      {
        icon: 'icon-hongbao',
        name: '我的红包'
      },
      {
        icon: 'icon-huiyuan',
        name: '会员plus'
      },
      {
        icon: 'icon-yaoqing',
        name: '邀请返利'
      },
      {
        icon: 'icon-yijianfankui',
        name: '意见反馈'
      },
      {
        icon: 'icon-kefu',
        name: '客服咨询'
      },
      {
        icon: 'icon-baohu',
        name: '账户安全'
      }
    ]
  }
  showPower (item) {
    if('link' in item){
      this.props.history.push(item.link)
    } else {
      Toast.offline(`${item.name}功能还未解锁，请耐心等候~`,1)
    }
  }
  loginOut () {
    this.props.actions.loginFailure()
    window.localStorage.removeItem('token')
    window.localStorage.removeItem('nideShopUser')
  }
  render () {
    const userPhone = window.localStorage.getItem('nideShopUser')
    return (
      <div id="minePage">
        <div className="userMsgWrap">
          <div className="userLogo"></div>
          {
            userPhone?
              <div className="userMsgs">
                <div>{userPhone}</div>
                <div>普通用户</div>
              </div>:
              <div className="userMsgs">
                <div style={{height: '100%'}}>未登录</div>
              </div>
          }
        </div>
        <div className="userPower">
          {
            this.state.userPower.map((item) => (
              <div key={item.name} onClick={this.showPower.bind(this,item)} style={'link' in item?{color:'#2196f3'}:{}}>
                <i className={`iconfont ${item.icon}`} style={'link' in item?{color:'#2196f3'}:{}}></i>
                <div>{item.name}</div>
              </div>)
            )
          }
        </div>

        <div className="loginOut" onClick={this.loginOut.bind(this)}>退出登录</div>
      </div>
    )
  }
}
const mapStateToProps = (state, props) => ({...state.common})
const mapDispatchToProps = dispatch => ({actions: bindActionCreators(commonAction, dispatch)})
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(Mine))
