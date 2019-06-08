import React, { Component } from 'react'
import { Modal, Button } from 'antd-mobile'
import './index.scss'
import Header from '../../components/header'
import { connect } from 'react-redux'
import { bindActionCreators } from 'redux'
import * as commonAction from '../../redux/actions/common'
import { withRouter } from 'react-router-dom'
import delAddress from '../../static/img/del-address.png'
import http from '../../http'
import AddressSet from '../../components/addressSet'
class Address extends Component {
  state = {
    addressList: []
  }

  goBack() {
    this.props.history.go(-1)
  }
  componentDidMount() {
    this.fetchData()
  }

  async fetchData() {
    this.props.actions.startLoading()
    const data = await http.getAddressList()
    this.setState({ addressList: data }, () => {
      this.props.actions.endLoading()
    })
  }

  deleteAddress(id) {
    const alertInstance = Modal.alert('删除', '您确定删除该地址吗????', [
      {
        text: '否',
        onPress: () => {
          alertInstance.close()
        }
      },
      {
        text: '是',
        onPress: async () => {
          this.props.actions.startLoading()
          await http.postDelteAddress({ id })
          this.fetchData()
        }
      }
    ])
  }

  render() {
    return (
      <div id="addressPage">
        <Header clickLeft={this.goBack.bind(this)} title="地址管理" />
        <AddressSet />
        {this.state.addressList.length !== 0 && (
          <div className="addressList">
            {this.state.addressList.map(item => (
              <div className="addressItem" key={item.id}>
                {item.is_default === 1 && <div className="isChooseAddress" />}
                <div className="addressMsg">
                  <div className="concatName">{item.name}</div>
                  <div className="addressDetail">
                    <div className="concatPhone">{item.mobile}</div>
                    <div className="concatAddress">{item.full_region}</div>
                    <div className="concatAddress">{item.address}</div>
                  </div>
                  <div
                    className="deleteAddress"
                    onClick={() => {
                      this.deleteAddress(item.id)
                    }}
                  >
                    <img src={delAddress} alt="delAddress" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="addAddress">
          <Button
            type="primary"
            onClick={() => {
              Modal.prompt('开发中', '请耐心等候！')
            }}
            inline
            style={{
              marginRight: '4px',
              lineHeight: '1rem',
              height: '1rem',
              width: '100%',
              borderRadius: 0
            }}
          >
            新建地址
          </Button>
        </div>
      </div>
    )
  }
}
const mapStateToProps = (state, props) => ({ ...state.common })
const mapDispatchToProps = dispatch => ({
  actions: bindActionCreators(commonAction, dispatch)
})
export default withRouter(
  connect(
    mapStateToProps,
    mapDispatchToProps
  )(Address)
)
