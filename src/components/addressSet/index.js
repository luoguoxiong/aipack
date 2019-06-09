import React, { Component } from 'react'
import './index.scss'
import isCheck from '../../static/img/isCheck.png'
import noCheck from '../../static/img/noCheck.png'
import { Modal, PickerView, Button } from 'antd-mobile'
class AddressSet extends Component {
  state = {
    isDefault: false,
    visible: false,
    pickerVal: ['02', '02-1', '02-1-1']
  }
  changeDetault = status => {
    this.setState({
      isDefault: !status
    })
  }
  openModel = () => {
    this.setState({
      visible: true
    })
  }
  render() {
    const { isDefault } = this.state
    return (
      <div className="addressSetPage">
        <div className="addressHeader">修改地址</div>
        <div className="onePx_bottom">
          <input className="addressInput" placeholder="姓名" />
        </div>
        <div className="onePx_bottom">
          <input className="addressInput" placeholder="电话号码" />
        </div>
        <div className="onePx_bottom" onClick={this.openModel}>
          <div className="chooseAddress">请选择地址！</div>
        </div>
        <div className="onePx_bottom">
          <input className="addressInput" placeholder="详细地址" />
        </div>
        <div className="onePx_bottom">
          <div
            className="isDefaultAddress"
            onClick={this.changeDetault.bind(this, isDefault)}
          >
            设置默认地址
            <img src={isDefault ? isCheck : noCheck} alt="check" />
          </div>
        </div>
        <div className="closeAddress">
          <Button
            type="primary"
            inline
            onClick={this.props.closeAddressDo}
            style={{
              marginRight: '4px',
              lineHeight: '1rem',
              height: '1rem',
              width: '100%',
              borderRadius: 0
            }}
          >
            保存
          </Button>
        </div>
        {this.renderModel()}
      </div>
    )
  }

  closeModel(val) {
    this.setState({
      visible: !val
    })
  }

  renderModel() {
    const { visible } = this.state
    return (
      <Modal
        popup
        onClose={this.closeModel.bind(this, visible)}
        visible={visible}
        animationType="slide-up"
      >
        <div className="modelCloseWrap onePx_bottom">
          <div
            className="pickBtn"
            onClick={this.closeModel.bind(this, visible)}
          >
            取消
          </div>
          <div
            className="pickBtn"
            onClick={this.closeModel.bind(this, visible)}
          >
            确定
          </div>
        </div>
        {this.renderPickerView()}
      </Modal>
    )
  }

  pcickerChange = val => {
    console.log(val, this.state.pickerVal)
    this.setState({ pickerVal: val })
  }

  renderPickerView() {
    const { pickerVal } = this.state
    const province = [
      {
        label: '北京',
        value: '01',
        children: [
          {
            label: '东城区',
            value: '01-1'
          },
          {
            label: '西城区',
            value: '01-2'
          },
          {
            label: '崇文区',
            value: '01-3'
          },
          {
            label: '宣武区',
            value: '01-4'
          }
        ]
      },
      {
        label: '浙江',
        value: '02',
        children: [
          {
            label: '杭州',
            value: '02-1',
            children: [
              {
                label: '西湖区',
                value: '02-1-1'
              },
              {
                label: '上城区',
                value: '02-1-2'
              },
              {
                label: '江干区',
                value: '02-1-3'
              },
              {
                label: '下城区',
                value: '02-1-4'
              }
            ]
          },
          {
            label: '宁波',
            value: '02-2',
            children: [
              {
                label: 'xx区',
                value: '02-2-1'
              },
              {
                label: 'yy区',
                value: '02-2-2'
              }
            ]
          },
          {
            label: '温州',
            value: '02-3'
          },
          {
            label: '嘉兴',
            value: '02-4'
          },
          {
            label: '湖州',
            value: '02-5'
          },
          {
            label: '绍兴',
            value: '02-6'
          }
        ]
      }
    ]

    return (
      <PickerView
        onChange={this.pcickerChange}
        data={province}
        value={pickerVal}
      />
    )
  }
}
export default AddressSet
