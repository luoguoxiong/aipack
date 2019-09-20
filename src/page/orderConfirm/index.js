import React, { Component } from 'react'
import './index.scss'
import Header from '../../components/header'
import { withRouter } from 'react-router-dom'
import http from '../../http'
class OrderConfirm extends Component {
  async componentWillMount() {
    const { data } = await http.postCheckOne({
      goodsId: 1155015,
      number: 1,
      productId: 242
    })
    const { checkedAddress } = data
    this.setState({
      checkedAddress
    })
    console.log(data)
  }
  state = {
    checkedAddress: {}
  }
  goBack = () => {
    this.props.history.go(-1)
  }
  render() {
    const { checkedAddress } = this.state
    return (
      <div id="orderConfirm">
        <Header clickLeft={this.goBack} title="23" />
        {'address' in checkedAddress ? (
          <div className="address">
            <div className="addressUserName">
              <div>{checkedAddress.name}</div>
            </div>
            <div className="addressMsg">
              <div>{checkedAddress.mobile}</div>
              <div>{checkedAddress.address}</div>
            </div>
            <div className="moreAddress">
              <i className="iconfont icon-right" />
            </div>
          </div>
        ) : (
          ''
        )}
      </div>
    )
  }
}

export default withRouter(OrderConfirm)
